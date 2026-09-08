import type { NextRequest } from 'next/server';
import { withAuth } from '@/lib/auth';
import { ApiRouteError, jsonSuccess } from '@/lib/apiResponse';
import { parseJsonBody, recalculateMealRequestSchema } from '@/lib/validation';
import { getPendingAnalysisForUser } from '@/services/analysis/analysisStore';
import { getFoodMatcher, getFoodNormalizer, matchFoodForRecalculate } from '@/services/foodMatching/foodMatcher';
import { getNutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import { buildRecalculatedFoodItems, calculateMealTotalsFromMatches } from '@/services/nutrition/calculate';
import type { RecalculateMealResponse } from '@/types/api';

/**
 * POST /api/meals/recalculate
 *
 * Per project decision, this NEVER trusts `FoodItem.calories` as sent by
 * the client. Every food is independently re-derived:
 *
 *   edited food name/portion -> normalize -> fresh USDA lookup ->
 *   deterministic per-100g scaling (services/nutrition/calculate.ts) ->
 *   sum
 *
 * This does NOT reconcile against the analysis session's originally
 * stored `foodMatches` — every food is re-looked-up from scratch on
 * every call, whether unchanged, edited, or newly added in Review.
 * `analysisId` is still required and verified (ownership + not expired)
 * so this can't be called against an arbitrary/fake session, but its
 * stored data isn't read for the calculation itself.
 *
 * ALL-OR-NOTHING per project decision: if ANY requested food can't get a
 * confident USDA match, this endpoint fails the whole request with
 * `nutrition_lookup_error` naming the food(s) that couldn't be matched —
 * it does NOT silently drop that food and return totals for the rest,
 * which would understate the meal without any visible indication to the
 * user. (services/nutrition/calculate.ts's null-contributes-zero
 * behavior is still correct and unchanged for the `analyze` flow, where
 * a partial/low-confidence result is expected and surfaced via
 * `prediction.confidence` — recalculate's contract has no equivalent
 * per-item confidence signal to convey a partial result honestly, so
 * failing loudly is the only non-misleading option available today.)
 * A future contract addition (e.g. a per-food partial-match response)
 * could relax this — not designed here.
 */
export const POST = withAuth(async (req: NextRequest, { uid }) => {
  const body = await parseJsonBody(req, recalculateMealRequestSchema);

  await getPendingAnalysisForUser(body.analysisId, uid);

  const normalizer = getFoodNormalizer();
  const lookupProvider = getNutritionLookupProvider();
  const matcher = getFoodMatcher(lookupProvider);

  const matches = await Promise.all(body.foods.map((food) => matchFoodForRecalculate(food, normalizer, matcher)));

  const unmatched = matches.filter((match) => match.nutrition === null);
  if (unmatched.length > 0) {
    const names = unmatched.map((m) => m.detectedName).join(', ');
    throw new ApiRouteError(
      'nutrition_lookup_error',
      `Could not find reliable USDA nutrition data for: ${names}. Please adjust the food name or portion and try again.`,
    );
  }

  const totals = calculateMealTotalsFromMatches(matches);
  const recalculatedFoods = buildRecalculatedFoodItems(body.foods, matches);

  const response: RecalculateMealResponse = {
    foods: recalculatedFoods,
    calories: totals.calories,
    protein: totals.protein,
    carbs: totals.carbs,
    fats: totals.fats,
    fiber: totals.fiber,
  };

  return jsonSuccess(response);
});
