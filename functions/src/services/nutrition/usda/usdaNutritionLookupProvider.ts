import { ApiRouteError } from '@/lib/apiResponse';
import type { NutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import type { NutritionFactsPer100g } from '@/types/nutrition';
import { getUsdaFoodDetail, searchUsdaFoods, searchUsdaFoodsUnfiltered, UsdaApiError } from './usdaClient';
import { mapUsdaNutrients } from './usdaNutrientMapper';
import {
  FOOD_IDENTITY_GROUPS,
  LOW_FAT_METHODS,
  PREP_KEYWORDS,
  detectFoodIdentityCategory,
  pickBestUsdaMatch,
  rankUsdaMatches,
} from './usdaMatcher';
import type { BestMatch } from './usdaMatcher';
import type { UsdaMatchResult } from './types';

/**
 * The real pipeline, per the approved architecture:
 *
 *   normalized food description -> USDA search -> best food match ->
 *   nutrient extraction per 100g -> [returned to caller for deterministic
 *   portion scaling, which lives in services/nutrition/calculate.ts]
 *
 * Dependencies are injected (defaulting to the real usdaClient functions)
 * specifically so tests can substitute fixtures instead of hitting the
 * live USDA API — see services/nutrition/usda/__tests__/.
 */

export interface UsdaClientDeps {
  search: typeof searchUsdaFoods;
  searchUnfiltered: typeof searchUsdaFoodsUnfiltered;
  getDetail: typeof getUsdaFoodDetail;
}

const defaultDeps: UsdaClientDeps = {
  search: searchUsdaFoods,
  searchUnfiltered: searchUsdaFoodsUnfiltered,
  getDetail: getUsdaFoodDetail,
};

/** normalizedName already has a preparation-method word appended by the normalizer (see services/foodMatching/normalizer.ts) when one was detected — this pulls it back out for the matcher's cooked-vs-raw boosting, rather than widening the public interface with an extra parameter. */
function extractPreparationHint(normalizedName: string): string | undefined {
  const lower = normalizedName.toLowerCase();
  return PREP_KEYWORDS.find((kw) => lower.includes(kw));
}

/** Returns true when a USDA description contains "fried" or "breaded" — a calorie-significant preparation that must not substitute for low-fat queries. */
const isHighFatDesc = (description: string): boolean => /\bfried\b|\bbreaded\b/i.test(description);

/**
 * Resolved nutrition for one specific candidate — the payload the
 * detail-fetch availability loop below needs per attempt.
 */
interface FetchedNutrition {
  description: string;
  dataType?: string;
  mapped: NonNullable<ReturnType<typeof mapUsdaNutrients>>;
}

/**
 * Fetches and maps one candidate's detail record, or returns `null` if
 * that specific candidate's data is unusable — a known USDA API failure
 * (including the live 404s some Foundation-dataset FDC IDs return on GET
 * /food/{id} despite being valid, correctly-matched search results) or a
 * detail record missing a required macro. That `null` is the caller's cue
 * to try the next candidate rather than abort the whole lookup.
 *
 * Only `UsdaApiError` (a known request-level failure) is treated this way.
 * Anything else — a genuine unexpected/programming error — still
 * propagates, exactly as it did before this per-candidate retry existed;
 * swallowing arbitrary errors here would mask real bugs behind a generic
 * "next candidate" retry.
 */
async function fetchCandidateNutrition(fdcId: number, deps: UsdaClientDeps): Promise<FetchedNutrition | null> {
  let detail: Awaited<ReturnType<typeof getUsdaFoodDetail>>;
  try {
    detail = await deps.getDetail(fdcId);
  } catch (err) {
    if (err instanceof UsdaApiError) return null;
    throw err;
  }

  const mapped = mapUsdaNutrients(detail.foodNutrients);
  if (!mapped) return null;

  return { description: detail.description, dataType: detail.dataType, mapped };
}

/**
 * Preparation-safe fallback: called when the primary search returns only
 * fried/breaded candidates for a low-fat method query (roasted, grilled, …).
 * Replaces the specific preparation keyword with "cooked" and repeats the
 * search — "roasted cauliflower" → "cooked cauliflower" should find
 * "Cauliflower, cooked, boiled, drained" rather than "Fried cauliflower".
 * Returns null if the fallback also only yields fried/breaded results or if
 * the search fails — the caller's final guard then rejects it.
 */
async function tryPrepFallback(
  normalizedName: string,
  preparationHint: string,
  deps: UsdaClientDeps,
): Promise<BestMatch | null> {
  const fallbackQuery = normalizedName
    .replace(new RegExp(`\\b${preparationHint}\\b`, 'gi'), 'cooked')
    .replace(/\s+/g, ' ')
    .trim();
  if (fallbackQuery === normalizedName) return null;
  try {
    const results = await deps.search(fallbackQuery);
    const candidates = results.foods ?? [];
    if (candidates.length === 0) return null;
    const best = pickBestUsdaMatch(candidates, { preparationHint: 'cooked', queryText: normalizedName });
    if (!best || best.hasSemanticConflict || isHighFatDesc(best.candidate.description)) return null;
    return best;
  } catch {
    return null;
  }
}

/**
 * Identity-conflict fallback: called when the best USDA candidate has a
 * contradictory primary food identity (e.g. query says "potato" but USDA
 * says "Peppers, sweet, green"). Attempts two recovery strategies:
 *
 *  1. Composite-dish extraction — splits on connectors ("and", "with",
 *     "curry", …) and searches with just the first named component.
 *     "potato and green bean curry sauteed" → "potato sauteed".
 *
 *  2. Identity-keyword search — extracts the food identity category detected
 *     in the query and searches with just that keyword. Used for single-food
 *     queries that fail due to a poor USDA catalog match.
 *     "fresh mint leaves raw" → category: mint → keyword "mint" → "mint raw"
 *     → finds "Spearmint, raw".
 *
 * Returns null if both strategies fail — fail-safe, no fabrication.
 */
async function tryIdentityConflictFallback(
  normalizedName: string,
  preparationHint: string | undefined,
  deps: UsdaClientDeps,
): Promise<BestMatch | null> {
  const runSearch = async (query: string): Promise<BestMatch | null> => {
    try {
      const results = await deps.search(query);
      const candidates = results.foods ?? [];
      if (candidates.length === 0) return null;
      const best = pickBestUsdaMatch(candidates, { preparationHint, queryText: normalizedName });
      return best && !best.hasSemanticConflict ? best : null;
    } catch {
      return null;
    }
  };

  // Strategy 1: extract first component of a compound dish query.
  const firstComponent = normalizedName.split(/\s+(?:and|with|curry|masala|sabzi|stir.fry)\s+/i)[0]!.trim();
  if (firstComponent && firstComponent !== normalizedName) {
    const q = preparationHint ? `${firstComponent} ${preparationHint}` : `${firstComponent} cooked`;
    const result = await runSearch(q);
    if (result) return result;
  }

  // Strategy 2: search directly with the primary food identity keyword.
  const category = detectFoodIdentityCategory(normalizedName);
  if (category) {
    const group = FOOD_IDENTITY_GROUPS.find((g) => g.category === category);
    // Prefer a single-word keyword that USDA recognises (not a Hindi
    // transliteration like "aloo" or "gobi") — first keyword without a space.
    const keyword = group?.keywords.find((kw) => !kw.includes(' ')) ?? group?.keywords[0];
    if (keyword) {
      const q = preparationHint ? `${keyword} ${preparationHint}` : keyword;
      const result = await runSearch(q);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Full pipeline with all internal match metadata (fdcId, description,
 * dataType, score) preserved — useful for logging/debugging even though
 * the public NutritionLookupProvider interface only needs the final
 * NutritionFactsPer100g.
 */
export async function lookupUsdaMatchWithMetadata(
  normalizedName: string,
  deps: UsdaClientDeps = defaultDeps,
): Promise<UsdaMatchResult | null> {
  const preparationHint = extractPreparationHint(normalizedName);

  let candidates: Awaited<ReturnType<typeof searchUsdaFoods>>['foods'];
  try {
    const filtered = await deps.search(normalizedName);
    candidates = filtered.foods ?? [];

    if (candidates.length === 0) {
      // Fall back to an unfiltered search only if the preferred-dataType
      // search found nothing — see usdaClient.ts's doc comment.
      const unfiltered = await deps.searchUnfiltered(normalizedName);
      candidates = unfiltered.foods ?? [];
    }
  } catch (err) {
    if (err instanceof UsdaApiError) {
      throw new ApiRouteError('nutrition_lookup_error', err.message);
    }
    throw err;
  }

  if (!candidates || candidates.length === 0) {
    return null;
  }

  let best = pickBestUsdaMatch(candidates, { preparationHint, queryText: normalizedName });
  if (!best) return null;

  // Preparation-safe fallback: if the query requests a low-fat method
  // (roasted, grilled, baked…) but the best USDA candidate is fried or
  // breaded, retry with "cooked" to find a more appropriate generic entry.
  // Fried nutrition for a roasted/grilled dish can mean ~2× the actual
  // calorie count — prefer a lookup failure over silently doubling it.
  if (
    !best.hasSemanticConflict &&
    preparationHint &&
    LOW_FAT_METHODS.has(preparationHint) &&
    isHighFatDesc(best.candidate.description)
  ) {
    const prepFallback = await tryPrepFallback(normalizedName, preparationHint, deps);
    if (prepFallback) best = prepFallback;
  }

  // Identity conflict: the best available candidate has a contradictory
  // primary food identity (e.g. query says "potato" but USDA says "Peppers").
  // Attempt a targeted fallback before giving up — fail-safe if it finds
  // nothing credible (no fabrication, surface a nutrition_lookup_error).
  if (best.hasSemanticConflict) {
    const fallback = await tryIdentityConflictFallback(normalizedName, preparationHint, deps);
    if (!fallback) return null;
    best = fallback;
  }

  // Final guard: never return fried/breaded nutrition for a low-fat query
  // even if every fallback path also only returned fried results.
  if (preparationHint && LOW_FAT_METHODS.has(preparationHint) && isHighFatDesc(best.candidate.description)) {
    return null;
  }

  // Availability fallback: `best` has already cleared every semantic guard
  // above, but its specific USDA detail record can still turn out to be
  // unavailable (live example: fdcId 331897, a correctly-matched
  // "Chicken, ... drumstick, meat only, cooked, braised" Foundation entry,
  // 404s on GET /food/{id} even though it's a valid search result). That's
  // a per-record availability problem, not a matching problem — so instead
  // of failing the whole lookup, retry down the SAME candidate pool's
  // ranking, but only among candidates that also cleared the semantic
  // guards. A candidate any guard rejected is never used, no matter how
  // available its detail record is — availability never overrides
  // correctness. If every safe candidate's detail is unusable, this falls
  // through to `null` below → nutrition_lookup_error, same as before.
  const safeRankedCandidates = rankUsdaMatches(candidates, { preparationHint, queryText: normalizedName }).filter(
    (candidate) =>
      !candidate.hasSemanticConflict &&
      !(preparationHint && LOW_FAT_METHODS.has(preparationHint) && isHighFatDesc(candidate.candidate.description)),
  );
  const attempts = [best, ...safeRankedCandidates.filter((candidate) => candidate.candidate.fdcId !== best.candidate.fdcId)];

  for (const attempt of attempts) {
    const fetched = await fetchCandidateNutrition(attempt.candidate.fdcId, deps);
    if (!fetched) continue;

    const nutritionPer100g: NutritionFactsPer100g = {
      source: 'usda_fdc',
      sourceId: String(attempt.candidate.fdcId),
      description: fetched.description,
      dataType: fetched.dataType,
      matchScore: attempt.confidence,
      caloriesPer100g: fetched.mapped.caloriesPer100g,
      proteinPer100g: fetched.mapped.proteinPer100g,
      carbsPer100g: fetched.mapped.carbsPer100g,
      fatsPer100g: fetched.mapped.fatsPer100g,
      fiberPer100g: fetched.mapped.fiberPer100g,
    };

    return {
      fdcId: attempt.candidate.fdcId,
      description: fetched.description,
      dataType: fetched.dataType ?? 'unknown',
      score: attempt.confidence,
      nutritionPer100g,
    };
  }

  // Every safe candidate's detail/nutrients were unusable — do not fabricate;
  // report no match (the caller surfaces nutrition_lookup_error) rather than
  // a partial/zero-filled one.
  return null;
}

/** Implements the generic NutritionLookupProvider interface (services/nutrition/nutritionLookup.ts) using the pipeline above. */
export function createUsdaNutritionLookupProvider(deps: UsdaClientDeps = defaultDeps): NutritionLookupProvider {
  return {
    async lookup(normalizedName: string): Promise<NutritionFactsPer100g | null> {
      const match = await lookupUsdaMatchWithMetadata(normalizedName, deps);
      return match?.nutritionPer100g ?? null;
    },
  };
}
