import { ApiRouteError } from '@/lib/apiResponse';
import { getFoodMatcher, getFoodNormalizer } from '@/services/foodMatching/foodMatcher';
import { calculateFoodItemTotals, calculateMealTotalsFromMatches, calculateOverallConfidence } from '@/services/nutrition/calculate';
import { evaluateClarificationPolicy } from './clarification';
import type { VisionAnalysisInput, VisionProvider } from '@/services/ai/visionProvider';
import type { NutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import type { AiMealPrediction, ClarificationQuestion, FoodItem } from '@/types/models';
import type { AiVisionResult, FoodMatch } from '@/types/nutrition';

/**
 * The core `analyze` logic (steps 4-11 of the endpoint's requirements:
 * call vision provider through generating clarification questions),
 * extracted from the route handler specifically so it's testable with a
 * mocked AI provider and a mocked nutrition lookup provider — no Firebase
 * Admin auth, no real network calls, no Next.js request/response
 * plumbing required to exercise this logic. See
 * services/analysis/__tests__/analyzePipeline.test.ts.
 *
 * The route handler (app/api/meals/analyze/route.ts) is left with just:
 * auth, request validation, usage check, calling this, persisting the
 * result, and shaping the HTTP response.
 */

export interface AnalyzePipelineDeps {
  visionProvider: VisionProvider;
  lookupProvider: NutritionLookupProvider;
}

export interface AnalyzePipelineResult {
  aiResult: AiVisionResult;
  foodMatches: FoodMatch[];
  prediction: AiMealPrediction;
  clarificationQuestions: ClarificationQuestion[];
}

export async function runAnalyzePipeline(input: VisionAnalysisInput, deps: AnalyzePipelineDeps): Promise<AnalyzePipelineResult> {
  const aiResult = await deps.visionProvider.analyzeMealImage(input);

  // Failure policy: no fabricated meal when nothing was detected.
  if (aiResult.detectedFoods.length === 0) {
    throw new ApiRouteError(
      'invalid_request',
      'No food items were detected in this photo. Please try again with a clearer, well-lit photo showing the food.',
    );
  }

  const normalizer = getFoodNormalizer();
  const matcher = getFoodMatcher(deps.lookupProvider);

  // normalizer.normalize throws ApiRouteError('invalid_request', ...) for
  // a specific food if its portion grams are invalid/undeterminable —
  // failure policy: invalid portion grams fail the request, not a
  // guessed default (see services/foodMatching/normalizer.ts).
  const foodMatches = await Promise.all(
    aiResult.detectedFoods.map((detected) => {
      const normalized = normalizer.normalize(detected);
      return matcher.match(detected.rawName, normalized);
    }),
  );

  // Failure policy: all-or-nothing — never silently omit an unmatched
  // food and under-total the rest (same rule as recalculate).
  const unmatched = foodMatches.filter((match) => match.nutrition === null);
  if (unmatched.length > 0) {
    const names = unmatched.map((match) => match.detectedName).join(', ');
    throw new ApiRouteError(
      'nutrition_lookup_error',
      `Could not find reliable USDA nutrition data for: ${names}. Please try scanning again, or add these items manually.`,
    );
  }

  const totals = calculateMealTotalsFromMatches(foodMatches);
  const confidence = calculateOverallConfidence(
    foodMatches,
    aiResult.detectedFoods.map((food) => food.detectionConfidence),
  );

  const foods: FoodItem[] = foodMatches.map((match, index) => ({
    id: `food-${index}`,
    name: match.normalizedName,
    // Prefer the AI's own human-friendly label when it gave one;
    // otherwise fall back to a plain gram figure.
    portionLabel: aiResult.detectedFoods[index]?.estimatedPortionLabel ?? `${match.portionGrams} g`,
    portionGrams: match.portionGrams,
    calories: calculateFoodItemTotals(match.portionGrams, match.nutrition!).calories,
    confidence: match.matchConfidence,
  }));

  const clarificationQuestions = evaluateClarificationPolicy(aiResult, foodMatches);

  const prediction: AiMealPrediction = {
    foods,
    calories: totals.calories,
    protein: totals.protein,
    carbs: totals.carbs,
    fats: totals.fats,
    fiber: totals.fiber,
    confidence,
    modelVersion: aiResult.modelVersion,
    analyzedAt: new Date().toISOString(),
    clarificationQuestions: clarificationQuestions.length > 0 ? clarificationQuestions : undefined,
  };

  return { aiResult, foodMatches, prediction, clarificationQuestions };
}
