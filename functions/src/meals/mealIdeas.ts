import type { Request, Response } from 'express';
import { withAuth } from '@/lib/auth';
import { ApiRouteError, jsonSuccess } from '@/lib/apiResponse';
import { mealIdeasRequestSchema, parseJsonBody } from '@/lib/validation';
import { getAdminFirestore } from '@/lib/firebaseAdmin';
import { assertPro } from '@/services/usage/requirePro';
import { getNutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import { suggestMealIdeas } from '@/services/suggestions/mealIdeas';
import { toScanMenuDish, type ScanMenuDish } from './menu';

/**
 * POST /mealIdeas — CalHow Pro "What Should I Eat Next?" new ideas. The
 * app sends what's left of today (it already has those totals); diet type
 * and allergies are read from the user's own profile. Each idea comes back
 * as a pending analysis, logged through the normal review flow.
 */

export interface MealIdeasResponse {
  ideas: ScanMenuDish[];
}

export const mealIdeasHandler = withAuth(async (req: Request, res: Response, { uid }) => {
  const body = parseJsonBody(req, mealIdeasRequestSchema);
  await assertPro(uid);

  const profile = (await getAdminFirestore().collection('users').doc(uid).get()).data() ?? {};
  const diet = profile.dietaryPreferences ?? {};

  const results = await suggestMealIdeas(
    {
      remainingCalories: body.remainingCalories,
      remainingProtein: body.remainingProtein,
      mealType: body.mealType,
      dietType: diet.dietType,
      allergies: diet.allergies,
      dislikedIngredients: diet.dislikedIngredients,
    },
    getNutritionLookupProvider(),
  );
  if (results.length === 0) {
    throw new ApiRouteError('ai_provider_error', "We couldn't find ideas that fit what's left today. Please try again.");
  }

  const response: MealIdeasResponse = { ideas: await Promise.all(results.map((result) => toScanMenuDish(uid, result))) };
  jsonSuccess(res, response);
});
