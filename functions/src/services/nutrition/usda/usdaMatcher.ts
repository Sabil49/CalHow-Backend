import type { UsdaSearchResultItem } from './types';

/**
 * V1 practical matching strategy — picks the best USDA search result for
 * a normalized query. Deliberately isolated in its own module (per the
 * requirement to keep matching improvable independently) rather than
 * folded into the client or the lookup provider.
 *
 * Ranking approach: start from USDA's own relevance `score` (their
 * search is a reasonably good full-text ranking already), then apply a
 * small number of targeted, documented heuristic adjustments for the one
 * failure mode explicitly called out: preferring the right PREPARATION
 * STATE (e.g. "grilled chicken breast" should prefer a cooked/grilled
 * entry over raw chicken, nuggets, or an unrelated branded product).
 *
 * Identity guards added after live validation:
 *  - Food-identity semantic guard: candidates whose primary food category
 *    (protein, vegetable, herb) contradicts the query's receive a large
 *    penalty so they never silently win over a correct match, and are
 *    rejected entirely if they would still win. Covers proteins (beef vs
 *    paneer), vegetables (potato vs peppers), and herbs (mint vs moringa).
 *  - Calorie-significant preparation mismatch: a "roasted/grilled/baked"
 *    query matched to a "fried" or "breaded" USDA entry is penalized
 *    rather than rewarded, since fried entries can be ~2× the calories
 *    of the equivalent dry-heat preparation.
 *  - Edible-part qualifier guard: a "skin-only" USDA entry (e.g. "Chicken,
 *    skin (drumsticks and thighs), cooked, braised" — ~443 kcal/100g, vs.
 *    ~150-200 kcal/100g for the actual cut) is penalized/rejected for any
 *    query that didn't itself ask for skin, regardless of cut or food
 *    family — a plain "chicken drumstick"/"chicken pieces"/"chicken" query
 *    should never silently resolve to skin-only nutrition.
 *
 * This is intentionally simple — no embeddings, no synonym tables, no
 * product-category classifier. Good enough for common single-ingredient
 * queries; a known limitation for compound/mixed dishes (see the
 * integration report).
 */

export const PREP_KEYWORDS = ['grilled', 'roasted', 'boiled', 'steamed', 'fried', 'baked', 'poached', 'sauteed', 'braised', 'cooked', 'raw'] as const;

/** Descriptions containing these are almost never what a plain ingredient query means — penalized, not excluded outright, in case nothing better exists. */
const OFF_TARGET_KEYWORDS = ['nugget', 'patty', 'sausage', 'soup', 'sandwich', 'pizza', 'dinner', 'meal', 'baby food'];

/**
 * Low-fat cooking methods: used to detect calorie-significant mismatches
 * where a dry-heat query lands on a fried/breaded USDA candidate.
 * "Fried" can add 2-3× the calories of the equivalent roasted/grilled
 * preparation, so we penalise rather than reward these cross-matches.
 * Exported so the lookup provider can use the same set for fallback logic.
 */
export const LOW_FAT_METHODS = new Set(['roasted', 'grilled', 'baked', 'broiled', 'steamed', 'poached']);

// ---------------------------------------------------------------------------
// Food-identity semantic guard (proteins, vegetables, herbs)
// ---------------------------------------------------------------------------

/**
 * Mutually-exclusive food-identity groups covering proteins, key vegetables,
 * and herbs. If a query's primary food belongs to one group and the USDA
 * candidate's description belongs to a *different* group, that is a semantic
 * contradiction (e.g. query says "potato" but candidate says "Peppers, sweet,
 * green"). Such candidates receive a heavy score penalty and are rejected if
 * they still win.
 *
 * Design rules (keep conservative):
 *  - Only add a category where identity confusion causes a nutritionally
 *    significant error (wrong protein = 2-10× protein difference; wrong
 *    vegetable = 2-5× calorie difference).
 *  - Single-word keywords use word-boundary matching (so 'egg' does not
 *    fire on 'eggplant', 'pepper' does not fire on 'pepperoni').
 *  - 'peppers' (plural) is used for bell/sweet peppers to avoid matching
 *    "Pepper, black" (spice) or "pepperoni".
 *  - Proteins are listed first: they take priority when a query contains
 *    both a protein and a vegetable keyword ("palak paneer" → protein wins).
 */
export const FOOD_IDENTITY_GROUPS: Array<{ category: string; keywords: string[] }> = [
  // Proteins
  { category: 'beef', keywords: ['beef', 'steak', 'brisket', 'veal', 'ground beef'] },
  { category: 'chicken', keywords: ['chicken', 'broiler', 'hen', 'poultry', 'capon'] },
  { category: 'pork', keywords: ['pork', 'ham', 'bacon', 'lard', 'hog'] },
  { category: 'lamb', keywords: ['lamb', 'mutton', 'goat'] },
  { category: 'fish', keywords: ['fish', 'salmon', 'tuna', 'cod', 'tilapia', 'mackerel', 'herring', 'sardine', 'trout', 'catfish', 'halibut', 'bass'] },
  { category: 'seafood', keywords: ['shrimp', 'prawn', 'crab', 'lobster', 'clam', 'oyster', 'squid', 'scallop'] },
  { category: 'paneer', keywords: ['paneer'] },
  { category: 'tofu', keywords: ['tofu', 'tempeh'] },
  { category: 'legume', keywords: ['lentil', 'dal', 'dhal', 'chickpea', 'garbanzo', 'kidney bean', 'black bean', 'pinto bean', 'soybean', 'edamame'] },
  { category: 'egg', keywords: ['egg', 'eggs'] },
  // Vegetables — only categories where a mismatch causes a nutritionally
  // significant error AND keywords are unambiguous in both plain queries
  // and USDA descriptions.
  { category: 'potato', keywords: ['potato', 'aloo'] },
  { category: 'cauliflower', keywords: ['cauliflower', 'gobi'] },
  { category: 'spinach', keywords: ['spinach', 'palak'] },
  { category: 'pepper_vegetable', keywords: ['peppers', 'capsicum'] },
  { category: 'green_bean', keywords: ['green bean', 'snap bean', 'string bean', 'french bean'] },
  // Herbs — prevents mint from being matched to drumstick leaves (moringa),
  // which are a completely different plant with different nutritional profile.
  { category: 'mint', keywords: ['mint', 'spearmint', 'peppermint'] },
  { category: 'moringa', keywords: ['drumstick leaves', 'moringa'] },
];

/**
 * Detects the primary food identity category for a piece of text (either a
 * query string or a USDA description). Returns the first matching category
 * from FOOD_IDENTITY_GROUPS, or undefined if the text doesn't clearly name
 * a member of any group.
 *
 * Single-word keywords use word-boundary matching to avoid false positives
 * (e.g. 'egg' must not match 'eggplant'). Multi-word keywords use substring
 * matching (order-sensitive phrase match).
 */
export function detectFoodIdentityCategory(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const { category, keywords } of FOOD_IDENTITY_GROUPS) {
    for (const kw of keywords) {
      const matched = kw.includes(' ')
        ? lower.includes(kw) // multi-word: phrase match
        : new RegExp(`\\b${kw}\\b`).test(lower); // single word: word-boundary match
      if (matched) return category;
    }
  }
  return undefined;
}

function hasFoodIdentityConflict(queryText: string, description: string): boolean {
  const queryCategory = detectFoodIdentityCategory(queryText);
  if (!queryCategory) return false;
  const descCategory = detectFoodIdentityCategory(description);
  if (!descCategory) return false;
  return queryCategory !== descCategory;
}

// ---------------------------------------------------------------------------
// Edible-part qualifier guard (skin-only vs meat-only/meat-and-skin/whole)
// ---------------------------------------------------------------------------

/**
 * Which edible part a piece of text (query or USDA description) explicitly
 * identifies, based only on the presence of the "skin" / "meat" tokens.
 * Deliberately just these two tokens — not a cut/anatomy ontology — so this
 * generalizes across any meat, not just chicken: "skin" alone means
 * skin-only (much higher fat than the equivalent meat/whole-part entry,
 * e.g. USDA's "Chicken, skin (drumsticks and thighs), cooked, braised"),
 * "skin" + "meat" together means the whole/composite part (meat-and-skin),
 * "meat" alone means meat-only, and neither means unspecified — the common
 * case for a plain query like "chicken drumstick" or "chicken pieces",
 * which names a cut, not a specific edible part of it.
 */
export type EdiblePartQualifier = 'skin-only' | 'meat-only' | 'meat-and-skin' | 'unspecified';

export function detectEdiblePartQualifier(text: string): EdiblePartQualifier {
  const lower = text.toLowerCase();
  // "without skin" / "no skin" means skin was explicitly excluded — the
  // opposite of skin-only — so strip those mentions before token-matching
  // "skin" on its own (e.g. "Potato, cooked, boiled, without skin" must
  // not be classified as skin-only).
  const skinNegated = lower.replace(/\b(?:without|no)\s+skin\b/g, '');
  const hasSkin = /\bskin\b/.test(skinNegated);
  const hasMeat = /\bmeat\b/.test(lower);

  if (hasSkin && hasMeat) return 'meat-and-skin';
  if (hasSkin) return 'skin-only';
  if (hasMeat) return 'meat-only';
  return 'unspecified';
}

/**
 * True only for the one specific, nutritionally significant mismatch this
 * guard exists to catch: a skin-only USDA candidate (much higher fat/
 * calories than the same cut's meat or whole-part entry) winning for a
 * query that never asked for skin. A query that itself specifies skin
 * ("chicken skin") is exempt — that candidate is exactly what was asked
 * for. Meat-only, meat-and-skin, and unspecified candidates are never
 * flagged by this guard; they're handled by the identity/family guards
 * above, unchanged.
 */
function hasEdiblePartConflict(queryText: string, description: string): boolean {
  if (detectEdiblePartQualifier(description) !== 'skin-only') return false;
  return detectEdiblePartQualifier(queryText) !== 'skin-only';
}

// ---------------------------------------------------------------------------
// Coarse food-family semantic guard
// ---------------------------------------------------------------------------

/**
 * Broad food-family groups for a coarse semantic sanity check above the
 * specific-identity guard. The purpose is ONLY to reject obvious cross-family
 * contradictions — "mixed carrots and beans" matching "Chicken wing" — not to
 * build a comprehensive food ontology.
 *
 * Design rules:
 *  - Use simple substring matching (lower.includes) since precision matters
 *    less here than coverage. The conflict matrix is conservative enough that
 *    false positives are tolerable.
 *  - Animal families (meat, fish_seafood) are listed first so compound dish
 *    names like "chicken fried rice" classify as meat, not grain, preventing
 *    a false conflict against a chicken USDA entry.
 *  - No dairy or egg families: too many compound names ("butter chicken",
 *    "egg fried rice") cause false positives.
 *  - No legume family: dal/chickpea conflicts are already covered by the
 *    specific identity guard.
 */
const FOOD_FAMILY_GROUPS: Array<{ family: string; keywords: string[] }> = [
  { family: 'meat', keywords: ['chicken', 'beef', 'pork', 'lamb', 'mutton', 'turkey', 'duck', 'steak', 'wing', 'veal', 'ham', 'bacon', 'meat'] },
  { family: 'fish_seafood', keywords: ['fish', 'salmon', 'tuna', 'shrimp', 'prawn', 'crab', 'lobster', 'squid', 'scallop', 'oyster', 'clam', 'mackerel', 'herring', 'sardine', 'cod', 'tilapia'] },
  // Grain before vegetable: "vegetable fried rice" → 'rice' detected first →
  // family: grain. This keeps it in the same family as rice-paper entries
  // ("Roll with meat/shrimp, rice paper") which also contain 'rice', so the
  // shared-family exemption prevents that match from being rejected by the
  // family guard even though it is nutritionally poor.
  { family: 'grain', keywords: ['rice', 'bread', 'roti', 'naan', 'chapati', 'wheat', 'pasta', 'noodle', 'oat', 'quinoa', 'barley', 'tortilla'] },
  { family: 'vegetable', keywords: ['vegetable', 'carrot', 'spinach', 'cauliflower', 'broccoli', 'potato', 'onion', 'garlic', 'cucumber', 'zucchini', 'eggplant', 'cabbage', 'lettuce', 'celery', 'beet', 'radish', 'pumpkin', 'squash', 'pepper', 'mushroom'] },
  { family: 'fruit', keywords: ['apple', 'banana', 'mango', 'orange', 'grape', 'strawberry', 'berry', 'lemon', 'lime', 'peach', 'pear', 'plum'] },
  { family: 'herb', keywords: ['mint', 'spearmint', 'coriander', 'cilantro', 'parsley', 'basil', 'oregano', 'thyme', 'rosemary', 'dill'] },
];

/**
 * Which food families, if found in a USDA description, are an obvious
 * contradiction for a query of the given family. Intentionally one-directional:
 * plant-based query families (vegetable, grain, herb, fruit) reject animal
 * protein candidates. The reverse (meat → vegetable) is handled by the more
 * precise specific-identity guard above.
 */
const FAMILY_CONFLICTS: Record<string, Set<string>> = {
  vegetable: new Set(['meat', 'fish_seafood']),
  grain: new Set(['meat', 'fish_seafood']),
  herb: new Set(['meat', 'fish_seafood']),
  fruit: new Set(['meat', 'fish_seafood']),
};

function detectFoodFamily(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const { family, keywords } of FOOD_FAMILY_GROUPS) {
    if (keywords.some((kw) => lower.includes(kw))) return family;
  }
  return undefined;
}

function detectAllFoodFamilies(text: string): Set<string> {
  const lower = text.toLowerCase();
  const families = new Set<string>();
  for (const { family, keywords } of FOOD_FAMILY_GROUPS) {
    if (keywords.some((kw) => lower.includes(kw))) families.add(family);
  }
  return families;
}

/**
 * Returns true when the query belongs to a plant-based food family AND the
 * USDA description belongs only to an incompatible animal protein family,
 * with no family overlap between the two.
 *
 * The shared-family exemption is intentional: "vegetable fried rice" (grain)
 * matched to "Roll with meat/shrimp, rice paper" (grain + fish_seafood) is
 * NOT rejected because both contain grain — this treats such entries as
 * potentially legitimate mixed dishes. Specifically unrelated entries like
 * "Chicken wing, sauteed" (meat only) for a vegetable query have no overlap
 * and are correctly rejected.
 */
function hasCrossFamily(queryText: string, description: string): boolean {
  const queryFamily = detectFoodFamily(queryText);
  if (!queryFamily) return false;
  const conflicts = FAMILY_CONFLICTS[queryFamily];
  if (!conflicts) return false;

  const descFamilies = detectAllFoodFamilies(description);
  // Shared family → treat as a plausible mixed dish, not a contradiction.
  if (descFamilies.has(queryFamily)) return false;

  return [...descFamilies].some((f) => conflicts.has(f));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface MatcherOptions {
  /** Preparation keyword detected in the query (e.g. "grilled"), if any — see services/foodMatching/normalizer.ts. */
  preparationHint?: string;
  /** Full normalized query text, used for food-identity semantic conflict detection. */
  queryText?: string;
}

/**
 * Scores one USDA candidate against the query context. Returns a
 * normalized-ish score (USDA's raw score, typically double-digit to
 * low-hundreds, adjusted by flat heuristic deltas) — comparable only
 * against other candidates from the SAME search, not an absolute 0-1
 * scale. `pickBestUsdaMatch` converts the winner's relative standing into
 * a 0-1 confidence.
 */
function scoreCandidate(candidate: UsdaSearchResultItem, options: MatcherOptions): number {
  const description = candidate.description.toLowerCase();
  let score = candidate.score ?? 0;

  // Prefer generic reference data over Branded products for a plain
  // ingredient query — a branded item is rarely what a photo-detected
  // "chicken breast" should resolve to.
  if (candidate.dataType === 'Branded') {
    score -= 15;
  }

  if (options.preparationHint) {
    const hint = options.preparationHint.toLowerCase();
    const impliesCooked = hint !== 'raw';
    const descriptionHasHint = description.includes(hint);
    const descriptionSaysRaw = description.includes('raw');
    const descriptionSaysCooked = PREP_KEYWORDS.filter((k) => k !== 'raw').some((k) => description.includes(k));

    if (descriptionHasHint) {
      score += 20; // exact preparation-method match
    } else if (impliesCooked && descriptionSaysCooked) {
      // The candidate is cooked, but by a different method.
      // Penalise if the query asks for a low-fat method and the candidate
      // is fried/breaded — this is a calorie-significant mismatch (roasted
      // cauliflower ≠ fried cauliflower, ~2× calorie difference).
      const descSaysFried = /\bfried\b|\bbreaded\b/.test(description);
      if (LOW_FAT_METHODS.has(hint) && descSaysFried) {
        score -= 15;
      } else {
        score += 8; // right general state (cooked), close enough method
      }
    } else if (impliesCooked && descriptionSaysRaw) {
      score -= 20; // wrong state entirely — query implies cooked, candidate is raw
    } else if (!impliesCooked && descriptionSaysRaw) {
      score += 12; // query explicitly wants raw, candidate is raw
    }
  }

  if (OFF_TARGET_KEYWORDS.some((kw) => description.includes(kw))) {
    score -= 10;
  }

  // Semantic guards: heavy penalty for candidates whose food identity (specific
  // or family-level) contradicts the query. Both checks use the same -100
  // delta so any non-conflicting candidate reliably outranks them, and if
  // none exists the winner's hasSemanticConflict flag triggers a fallback.
  if (
    options.queryText &&
    (hasFoodIdentityConflict(options.queryText, description) ||
      hasCrossFamily(options.queryText, description) ||
      hasEdiblePartConflict(options.queryText, description))
  ) {
    score -= 100;
  }

  return score;
}

export interface BestMatch {
  candidate: UsdaSearchResultItem;
  /** 0-1, normalized from this candidate's margin over the field. */
  confidence: number;
  /**
   * True when the winning candidate's primary food category (protein,
   * vegetable, or herb) contradicts the query's (e.g. query says "potato"
   * but winner says "Peppers, sweet, green"). The caller should treat this
   * as a lookup failure or attempt a targeted fallback rather than
   * silently returning nutritionally incorrect data.
   */
  hasSemanticConflict: boolean;
}

/**
 * Scores and ranks every candidate (not just the winner), each carrying its
 * own margin-based confidence (relative to the next-ranked entry) and its
 * own `hasSemanticConflict` flag — the same computation `pickBestUsdaMatch`
 * has always done for the single winner, generalized to the whole list.
 *
 * Exists for the detail-fetch availability fallback in
 * usdaNutritionLookupProvider.ts: when the top candidate's USDA detail
 * record turns out to be unavailable (e.g. a 404 on an otherwise-valid
 * search result), the caller needs the next-best candidate that ALSO
 * cleared the semantic guards — never one that didn't — which requires the
 * full ranked list, not just the single winner `pickBestUsdaMatch` returns.
 */
export function rankUsdaMatches(candidates: UsdaSearchResultItem[], options: MatcherOptions): BestMatch[] {
  if (candidates.length === 0) return [];

  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, options) }))
    .sort((a, b) => b.score - a.score);

  return scored.map((entry, index) => {
    const runnerUpScore = scored[index + 1]?.score ?? entry.score - 30; // no runner-up => treat as a clear, confident win

    // Margin-based confidence: a comfortable lead => close to 1; a
    // near-tie => closer to 0.5. Clamped to [0.3, 0.98] — even a clear
    // winner shouldn't report absolute certainty, and even a narrow win is
    // still a real match worth using (not zero).
    const margin = entry.score - runnerUpScore;
    const confidence = Math.max(0.3, Math.min(0.98, 0.5 + margin / 40));

    // Check if this candidate carries a semantic conflict (e.g. it only
    // ranks this high because no better alternative existed). The caller
    // must reject it or attempt a targeted fallback — never use wrong
    // nutrition.
    const semanticConflict = options.queryText
      ? hasFoodIdentityConflict(options.queryText, entry.candidate.description) ||
        hasCrossFamily(options.queryText, entry.candidate.description) ||
        hasEdiblePartConflict(options.queryText, entry.candidate.description)
      : false;

    return { candidate: entry.candidate, confidence, hasSemanticConflict: semanticConflict };
  });
}

/**
 * Picks the best candidate from a set of USDA search results, or null if
 * `candidates` is empty. Confidence is derived from how far ahead the
 * winner is over the runner-up (a clear best match => high confidence; a
 * close call between two very different foods => lower confidence) —
 * this is what FoodMatch.matchConfidence is ultimately built from.
 */
export function pickBestUsdaMatch(candidates: UsdaSearchResultItem[], options: MatcherOptions): BestMatch | null {
  return rankUsdaMatches(candidates, options)[0] ?? null;
}
