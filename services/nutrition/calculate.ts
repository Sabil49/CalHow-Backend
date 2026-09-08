import type { FoodMatch, MealTotals, NutritionFactsPer100g } from '@/types/nutrition';
import type { FoodItem } from '@/types/models';

/**
 * Deterministic nutrition math. Everything here is pure functions of
 * already-known numbers (grams + per-100g facts) — no AI calls, no
 * database calls. This is the "source of truth" calculation layer the
 * project's core nutrition rule requires: the AI helps identify what's
 * on the plate and roughly how much of it there is, but the actual
 * calorie/macro numbers always come from arithmetic over structured
 * nutrition data, computed here.
 */

/** Rounds to the nearest whole unit — calorie/gram values are always displayed as integers in the mobile app. */
function round(value: number): number {
  return Math.round(value);
}

/** Scales one food's per-100g nutrition facts to its actual portion size. */
export function calculateFoodItemTotals(portionGrams: number, per100g: NutritionFactsPer100g): MealTotals {
  const factor = portionGrams / 100;
  return {
    calories: round(per100g.caloriesPer100g * factor),
    protein: round(per100g.proteinPer100g * factor),
    carbs: round(per100g.carbsPer100g * factor),
    fats: round(per100g.fatsPer100g * factor),
    fiber: per100g.fiberPer100g != null ? round(per100g.fiberPer100g * factor) : undefined,
  };
}

/** Sums per-food totals into meal-level totals. `fiber` is included only if at least one item reported it. */
export function sumMealTotals(items: MealTotals[]): MealTotals {
  const hasFiber = items.some((item) => item.fiber != null);
  return items.reduce<MealTotals>(
    (acc, item) => ({
      calories: acc.calories + item.calories,
      protein: acc.protein + item.protein,
      carbs: acc.carbs + item.carbs,
      fats: acc.fats + item.fats,
      fiber: hasFiber ? (acc.fiber ?? 0) + (item.fiber ?? 0) : undefined,
    }),
    { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: hasFiber ? 0 : undefined },
  );
}

/**
 * Computes totals for every matched food and sums them into meal totals
 * in one step. Foods with `nutrition: null` (no confident database
 * match) contribute zero rather than a guessed value — see
 * `calculateOverallConfidence` below, which is what should drive
 * clarification/low-confidence UI for exactly this case, not a
 * fabricated number here.
 */
export function calculateMealTotalsFromMatches(matches: FoodMatch[]): MealTotals {
  const perItemTotals = matches.map((match) =>
    match.nutrition ? calculateFoodItemTotals(match.portionGrams, match.nutrition) : { calories: 0, protein: 0, carbs: 0, fats: 0 },
  );
  return sumMealTotals(perItemTotals);
}

/**
 * Builds the final FoodItem[] for the recalculate response.
 *
 * Every food's `calories` and `portionGrams` are derived from the USDA
 * match, not from whatever the client sent — maintaining the invariant that
 * sum(foods[].calories) === meal totals.calories (to integer rounding).
 * `portionLabel` is set from portionGrams so label and grams cannot
 * contradict each other (e.g. label still saying "14 g" after the user
 * edits portionGrams to 21).
 *
 * Non-nutritional fields (id, name, confidence, imageUrl) are preserved
 * from the source food so correction-diffing in result.tsx still works.
 */
export function buildRecalculatedFoodItems(
  sourceFoods: FoodItem[],
  matches: FoodMatch[],
): FoodItem[] {
  return sourceFoods.map((food, i) => {
    const match = matches[i];
    if (!match?.nutrition) {
      // Recalculate throws before reaching here if any match is null,
      // but guard defensively rather than silently returning stale data.
      return food;
    }
    const itemTotals = calculateFoodItemTotals(match.portionGrams, match.nutrition);
    return {
      ...food,
      portionGrams: match.portionGrams,
      portionLabel: `${match.portionGrams} g`,
      calories: itemTotals.calories,
    };
  });
}

/**
 * Combines each food's AI detection confidence with its own database
 * match confidence into one overall meal-level confidence score (0-1).
 * A food with no nutrition match at all (`nutrition: null`) contributes
 * a confidence of 0, correctly pulling the overall score down rather
 * than being silently excluded from the average.
 */
export function calculateOverallConfidence(matches: FoodMatch[], detectionConfidences: number[]): number {
  if (matches.length === 0) return 0;

  const perItemConfidence = matches.map((match, index) => {
    const detectionConfidence = detectionConfidences[index] ?? 0;
    const matchConfidence = match.nutrition ? match.matchConfidence : 0;
    return detectionConfidence * matchConfidence;
  });

  const sum = perItemConfidence.reduce((acc, value) => acc + value, 0);
  return Math.max(0, Math.min(1, sum / perItemConfidence.length));
}
