import type { Request, Response } from 'express';
import { withAuth } from '@/lib/auth';
import { ApiRouteError, jsonSuccess } from '@/lib/apiResponse';
import { mealInsightsRequestSchema, parseJsonBody } from '@/lib/validation';
import { getAdminFirestore, getFirestoreValues } from '@/lib/firebaseAdmin';
import { assertPro } from '@/services/usage/requirePro';
import { generateMealInsights, type Macros, type MealInsight } from '@/services/insights/mealInsights';
import type { Timestamp } from 'firebase-admin/firestore';
import type { FoodItem } from '@/types/models';

/**
 * POST /mealInsights — CalHow Pro "AI Meal Insights" for one saved meal.
 *
 * Results are cached on the meal document (`aiInsights`) together with the
 * totals they were based on, so reopening a meal doesn't pay for a second
 * AI call; editing the meal's totals makes the cache stale and the next
 * request regenerates it. Reads only the caller's own meals/profile
 * (users/{uid}/...), with uid from the verified token.
 */

interface StoredMeal extends Macros {
  mealType?: string;
  foods?: FoodItem[];
  loggedAt?: Timestamp;
  aiInsights?: { items: MealInsight[]; generatedAt: Timestamp; basis: Macros };
}

export interface MealInsightsResponse {
  insights: MealInsight[];
  generatedAt: string;
}

function basisOf(meal: StoredMeal): Macros {
  return { calories: meal.calories ?? 0, protein: meal.protein ?? 0, carbs: meal.carbs ?? 0, fats: meal.fats ?? 0 };
}

function sameBasis(a: Macros, b: Macros): boolean {
  return a.calories === b.calories && a.protein === b.protein && a.carbs === b.carbs && a.fats === b.fats;
}

/** [start, end) of the user's local calendar day containing `instant`, as UTC Dates. */
export function localDayBounds(instant: Date, tzOffsetMinutes: number): { start: Date; end: Date } {
  const offsetMs = tzOffsetMinutes * 60_000;
  const local = new Date(instant.getTime() - offsetMs);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const start = new Date(localMidnight + offsetMs);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60_000) };
}

export const mealInsightsHandler = withAuth(async (req: Request, res: Response, { uid }) => {
  const body = parseJsonBody(req, mealInsightsRequestSchema);
  await assertPro(uid);

  const userRef = getAdminFirestore().collection('users').doc(uid);
  const mealRef = userRef.collection('meals').doc(body.mealId);
  const mealSnap = await mealRef.get();
  if (!mealSnap.exists) {
    throw new ApiRouteError('not_found', 'This meal could not be found.');
  }
  const meal = mealSnap.data() as StoredMeal;
  const basis = basisOf(meal);

  if (meal.aiInsights?.items?.length && meal.aiInsights.basis && sameBasis(meal.aiInsights.basis, basis)) {
    const cached: MealInsightsResponse = {
      insights: meal.aiInsights.items,
      generatedAt: meal.aiInsights.generatedAt.toDate().toISOString(),
    };
    jsonSuccess(res, cached);
    return;
  }

  const loggedAt = meal.loggedAt?.toDate() ?? new Date();
  const { start, end } = localDayBounds(loggedAt, body.tzOffsetMinutes);
  const { Timestamp } = getFirestoreValues();
  const [profileSnap, daySnap] = await Promise.all([
    userRef.get(),
    userRef.collection('meals').where('loggedAt', '>=', Timestamp.fromDate(start)).where('loggedAt', '<', Timestamp.fromDate(end)).get(),
  ]);

  const dayMeals = daySnap.docs.map((doc) => doc.data() as StoredMeal);
  const dayTotals = dayMeals.reduce<Macros>(
    (acc, m) => ({
      calories: acc.calories + (m.calories ?? 0),
      protein: acc.protein + (m.protein ?? 0),
      carbs: acc.carbs + (m.carbs ?? 0),
      fats: acc.fats + (m.fats ?? 0),
      fiber: (acc.fiber ?? 0) + (m.fiber ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
  );

  const profile = profileSnap.data() ?? {};
  const goals = profile.goals ?? {};
  const { insights, model } = await generateMealInsights({
    meal: { ...basis, fiber: meal.fiber, mealType: meal.mealType ?? 'meal', foods: meal.foods ?? [] },
    dayTotals,
    mealsLoggedToday: Math.max(1, dayMeals.length),
    goals: {
      goalType: goals.goalType,
      dailyCalorieTarget: goals.dailyCalorieTarget,
      proteinG: goals.macroTargets?.proteinG,
      carbsG: goals.macroTargets?.carbsG,
      fatsG: goals.macroTargets?.fatsG,
      fiberG: goals.macroTargets?.fiberG,
    },
    diet: profile.dietaryPreferences,
  });

  if (insights.length === 0) {
    throw new ApiRouteError('ai_provider_error', 'No insights could be generated for this meal. Please try again.');
  }

  const generatedAt = Timestamp.now();
  await mealRef.set({ aiInsights: { items: insights, generatedAt, basis, model } }, { merge: true });

  const response: MealInsightsResponse = { insights, generatedAt: generatedAt.toDate().toISOString() };
  jsonSuccess(res, response);
});
