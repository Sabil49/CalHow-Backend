import { ApiRouteError } from '@/lib/apiResponse';
import { calculateFoodItemTotals } from '@/services/nutrition/calculate';
import { normalizeFoodDescription } from '@/services/foodMatching/normalizer';
import type { NutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import type { FoodItem, MealTotals } from '@/types/nutrition';

/**
 * Oil-amount clarification: converts the user's answer ("None" /
 * "Light" / "Regular" / "Heavy") into a real nutrition contribution via
 * USDA lookup + the existing deterministic calculation utilities — never
 * an invented calorie/fat delta.
 *
 * APPROVED V1 GRAM ASSUMPTIONS (do not duplicate these numbers anywhere
 * else — everything that needs them imports this constant):
 *   None    = 0g
 *   Light   = 5g  (~1 tsp)
 *   Regular = 14g (~1 tbsp)
 *   Heavy   = 28g (~2 tbsp)
 * These are a documented approximation, not a measurement — there is no
 * way to know the exact amount of oil used from a photo. The gram
 * figures are surfaced in the question's option descriptions (see
 * services/analysis/clarification.ts) so the user can see the assumption
 * being made, not just silently receive an adjusted number.
 */
export const OIL_GRAM_ASSUMPTIONS = {
  none: 0,
  light: 5,
  regular: 14,
  heavy: 28,
} as const;

export type OilAnswerLevel = keyof typeof OIL_GRAM_ASSUMPTIONS;

export function isOilAnswerLevel(value: string): value is OilAnswerLevel {
  return Object.prototype.hasOwnProperty.call(OIL_GRAM_ASSUMPTIONS, value);
}

/** `FoodItem.id` prefix stamped on every item this module creates (see `calculateOilContribution` below) — the single source of truth for identifying one of these items later, e.g. when the recalculate flow needs to re-derive its nutrition after a portion edit rather than re-deriving a USDA query from its display name. */
export const OIL_CLARIFICATION_ID_PREFIX = 'oil-clarification-';

export function isOilClarificationFoodId(id: string): boolean {
  return id.startsWith(OIL_CLARIFICATION_ID_PREFIX);
}

/** Rough, well-known household-measure equivalents for the approved gram amounts — used only for display text, never for calculation (calculation always uses the gram figure). */
const OIL_MEASURE_LABELS: Record<OilAnswerLevel, string> = {
  none: 'none',
  light: '~1 tsp',
  regular: '~1 tbsp',
  heavy: '~2 tbsp',
};

export function describeOilMeasure(level: OilAnswerLevel): string {
  return OIL_MEASURE_LABELS[level];
}

/**
 * Generic cooking-oil USDA reference query, used whenever the specific
 * oil type isn't known — which is the case for V1, since the AI pipeline
 * doesn't yet report an oil type as part of its detection.
 *
 * This is a documented, defensible generic choice, NOT an arbitrary pick
 * of one variety (e.g. sunflower): USDA SR Legacy data shows that
 * refined cooking/vegetable oils — canola, soybean, sunflower, corn,
 * generic "vegetable oil", etc. — are ~100% fat by composition and share
 * near-identical macros (~884 kcal/100g, ~100g fat, 0g protein/carbs,
 * 0g fiber). At the 5-28g quantities used here, the difference between
 * any two refined cooking oils is well under 5 kcal — nutritionally
 * interchangeable for this purpose. "Oil, vegetable" is USDA's own
 * generic catch-all entry for exactly this situation.
 */
export const GENERIC_COOKING_OIL_QUERY = 'oil, vegetable';

/**
 * If a specific oil type IS known (e.g. once the AI pipeline is extended
 * to report "olive oil" / "coconut oil" specifically from visual cues or
 * a future clarification question), pass it as `oilType` to look up that
 * oil's actual USDA entry instead of the generic reference — nothing
 * about this function's architecture assumes a single oil type, only its
 * current CALLER (the clarify route) doesn't yet have anywhere to source
 * a specific one from.
 */
export async function calculateOilContribution(
  answerLevel: OilAnswerLevel,
  lookupProvider: NutritionLookupProvider,
  oilType?: string,
): Promise<{ totals: MealTotals; foodItem: FoodItem | null }> {
  const grams = OIL_GRAM_ASSUMPTIONS[answerLevel];

  if (grams === 0) {
    return { totals: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 }, foodItem: null };
  }

  const query = oilType ? normalizeFoodDescription({ rawName: oilType, estimatedPortionGrams: grams }).normalizedName : GENERIC_COOKING_OIL_QUERY;

  const nutrition = await lookupProvider.lookup(query);
  if (!nutrition) {
    throw new ApiRouteError('nutrition_lookup_error', `Could not find USDA nutrition data for cooking oil ("${query}").`);
  }

  const totals = calculateFoodItemTotals(grams, nutrition);

  const foodItem: FoodItem = {
    id: `${OIL_CLARIFICATION_ID_PREFIX}${answerLevel}`,
    name: oilType ? `${oilType} (estimated)` : 'Cooking oil (estimated)',
    portionLabel: `${grams} g (${describeOilMeasure(answerLevel)})`,
    portionGrams: grams,
    calories: totals.calories,
    // Not a real detection — an assumption applied from the clarification
    // answer, so this is deliberately a moderate confidence, not the
    // matcher's own USDA match confidence.
    confidence: 0.6,
  };

  return { totals, foodItem };
}
