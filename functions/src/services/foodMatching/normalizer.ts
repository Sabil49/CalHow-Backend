import { ApiRouteError } from '@/lib/apiResponse';
import type { NormalizedFood } from '@/services/foodMatching/foodMatcher';
import type { NormalizerInput } from '@/types/nutrition';

/**
 * Turns raw, free-form food text (from either the AI vision stage or a
 * user-edited mobile FoodItem — both adapt to NormalizerInput, see
 * types/nutrition.ts) into a clean search string for USDA plus a
 * concrete gram amount.
 *
 * V1, deterministic, no AI/network calls — intentionally simple text
 * cleanup + a small preparation-method keyword list, not a general NLP
 * pipeline. Isolated here so the matching strategy in
 * services/nutrition/usda/usdaMatcher.ts can improve independently.
 */

const PREP_KEYWORDS = ['grilled', 'roasted', 'boiled', 'steamed', 'fried', 'baked', 'poached', 'sauteed', 'braised', 'cooked', 'raw'] as const;

function detectPreparationKeyword(text: string): string | undefined {
  return PREP_KEYWORDS.find((kw) => text.includes(kw));
}

/**
 * Sanitizes an AI-generated preparation string into a USDA-safe search
 * token. The AI occasionally emits slash-separated alternatives such as
 * "boiled/tempered" or "braised/simmered"; USDA's search API rejects any
 * query containing a forward slash with HTTP 400. Backslash, ampersand,
 * and stray punctuation are similarly normalised.
 *
 * Replacement rules (in order):
 *   /  \  → single space  ("boiled/tempered" → "boiled tempered")
 *   &     → " and "
 *   remaining non-alpha chars → space (consistent with rawName cleaning)
 *   repeated whitespace → single space
 */
export function sanitizePreparationForQuery(prep: string): string {
  return prep
    .toLowerCase()
    .replace(/[/\\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extracts a trailing gram figure from a portion label, e.g. "1/2 cup (90 g)" -> 90, "150g" -> 150. */
function extractGramsFromLabel(label?: string): number | undefined {
  if (!label) return undefined;
  const match = label.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  return match ? Number(match[1]) : undefined;
}

/**
 * Normalizes `input` into a USDA-searchable name + a portion in grams.
 *
 * Throws `ApiRouteError('invalid_request', ...)` — rather than silently
 * defaulting to an arbitrary gram amount — if no gram figure can be
 * determined from either an explicit estimate or the portion label. A
 * fabricated default portion would directly corrupt the resulting
 * calorie/macro numbers, which this project's core nutrition rule
 * doesn't allow.
 */
export function normalizeFoodDescription(input: NormalizerInput): NormalizedFood {
  const portionGrams = input.estimatedPortionGrams ?? extractGramsFromLabel(input.estimatedPortionLabel);
  if (portionGrams == null || portionGrams <= 0) {
    throw new ApiRouteError(
      'invalid_request',
      `Could not determine a gram amount for "${input.rawName}". A portion size in grams is required to look up nutrition.`,
    );
  }

  const cleaned = input.rawName
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // strip parenthetical portion notes, e.g. "(90 g)"
    .replace(/[^a-z\s]/g, ' ') // strip punctuation/digits
    .replace(/\s+/g, ' ')
    .trim();

  const prep =
    input.preparationMethod != null
      ? sanitizePreparationForQuery(input.preparationMethod)
      : detectPreparationKeyword(cleaned);
  const normalizedName = prep && !cleaned.includes(prep) ? `${cleaned} ${prep}` : cleaned;

  return { normalizedName, portionGrams };
}
