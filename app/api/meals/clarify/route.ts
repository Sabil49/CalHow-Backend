import type { NextRequest } from 'next/server';
import { withAuth } from '@/lib/auth';
import { ApiRouteError, jsonSuccess } from '@/lib/apiResponse';
import { clarifyMealRequestSchema, parseJsonBody } from '@/lib/validation';
import { getPendingAnalysisForUser, updatePendingAnalysis } from '@/services/analysis/analysisStore';
import { calculateOilContribution, isOilAnswerLevel } from '@/services/analysis/oilClarification';
import { getNutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import { sumMealTotals } from '@/services/nutrition/calculate';
import type { ClarifyMealResponse } from '@/types/api';
import type { AiMealPrediction, ClarificationAnswer } from '@/types/models';
import type { FoodItem, MealTotals } from '@/types/nutrition';

/**
 * POST /api/meals/clarify
 *
 * Operates entirely on the stored structured analysis
 * (`pendingAnalyses/{analysisId}`) — no image is received or re-fetched,
 * and the AI vision model is not re-invoked, per project decision.
 *
 * Each answer is applied via a per-question rule. Only "oil_amount" has
 * one implemented (see services/analysis/oilClarification.ts): the
 * user's answer maps to a documented gram assumption, a real USDA lookup
 * supplies that oil's actual per-100g nutrition, and
 * services/nutrition/calculate.ts's existing deterministic scaling
 * computes its contribution — never an invented calorie/fat delta. An
 * answer to any other question id has no rule yet and fails with
 * `not_implemented` rather than being silently ignored or guessed at.
 */
export const POST = withAuth(async (req: NextRequest, { uid }) => {
  const body = await parseJsonBody(req, clarifyMealRequestSchema);
  const analysis = await getPendingAnalysisForUser(body.analysisId, uid);

  const lookupProvider = getNutritionLookupProvider();

  let combinedTotals: MealTotals = { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 };
  const additionalFoodItems: FoodItem[] = [];

  for (const answer of body.answers) {
    const question = analysis.clarificationQuestions?.find((q) => q.id === answer.questionId);
    if (!question) {
      throw new ApiRouteError(
        'invalid_request',
        `"${answer.questionId}" is not a pending clarification question for this analysis.`,
      );
    }

    if (question.id === 'oil_amount') {
      if (!isOilAnswerLevel(answer.optionId)) {
        throw new ApiRouteError('invalid_request', `Unrecognized oil amount option "${answer.optionId}".`);
      }
      const { totals, foodItem } = await calculateOilContribution(answer.optionId, lookupProvider);
      combinedTotals = sumMealTotals([combinedTotals, totals]);
      if (foodItem) additionalFoodItems.push(foodItem);
      continue;
    }

    // No rule implemented for this question id yet — do not silently
    // ignore the answer or guess at its effect.
    throw new ApiRouteError(
      'not_implemented',
      `Clarification question "${question.id}" has no answer-application rule implemented yet.`,
    );
  }

  const updatedPrediction: AiMealPrediction = {
    ...analysis.prediction,
    foods: [...analysis.prediction.foods, ...additionalFoodItems],
    calories: analysis.prediction.calories + combinedTotals.calories,
    protein: analysis.prediction.protein + combinedTotals.protein,
    carbs: analysis.prediction.carbs + combinedTotals.carbs,
    fats: analysis.prediction.fats + combinedTotals.fats,
    fiber: (analysis.prediction.fiber ?? 0) + (combinedTotals.fiber ?? 0),
    clarificationQuestions: undefined,
  };

  const clarificationAnswers: ClarificationAnswer[] = body.answers;

  await updatePendingAnalysis(body.analysisId, uid, {
    status: 'complete',
    prediction: updatedPrediction,
    clarificationAnswers,
  });

  const response: ClarifyMealResponse = { prediction: updatedPrediction };
  return jsonSuccess(response);
});
