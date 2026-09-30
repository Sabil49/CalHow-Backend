import { z } from 'zod';
import { getAnthropicEnv } from '@/lib/env';
import { callClaudeStructured } from '@/services/ai/claudeClient';
import type { FoodItem } from '@/types/models';

/**
 * CalHow Pro "AI Meal Insights": 2-4 short, personalized notes about one
 * saved meal, in the context of the user's day and goals.
 *
 * The model only gets numbers CalHow already calculated (USDA-based meal
 * totals, the day's other meals, the user's targets) and is told not to
 * introduce any others — the same "AI never invents nutrition numbers"
 * rule as the scan pipeline.
 */

export const MEAL_INSIGHT_KINDS = ['positive', 'suggestion', 'watch'] as const;

const insightsSchema = z.object({
  insights: z.array(
    z.object({
      kind: z.enum(MEAL_INSIGHT_KINDS),
      title: z.string(),
      body: z.string(),
    }),
  ),
});

export interface MealInsight {
  kind: (typeof MEAL_INSIGHT_KINDS)[number];
  title: string;
  body: string;
}

export interface Macros {
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  fiber?: number;
}

export interface MealInsightsContext {
  meal: Macros & { mealType: string; foods: Pick<FoodItem, 'name' | 'portionLabel' | 'calories'>[] };
  /** All meals logged that day, INCLUDING this one. */
  dayTotals: Macros;
  mealsLoggedToday: number;
  goals?: {
    goalType?: string;
    dailyCalorieTarget?: number;
    proteinG?: number;
    carbsG?: number;
    fatsG?: number;
    fiberG?: number;
  };
  diet?: { dietType?: string; allergies?: string[]; dislikedIngredients?: string[] };
}

const SYSTEM_PROMPT = `You write short, practical nutrition insights about one logged meal for a user of CalHow, a calorie tracking app.

Ground every statement in the numbers provided: the meal, the user's day so far, and their goals. Don't state any calorie or nutrient amount that isn't given or directly derivable from what's given, and don't comment on nutrients that aren't listed (such as sodium, sugar or vitamins).

This is general wellness information, not medical advice: no diagnoses, no mention of medical conditions, medications or supplements, and no extreme advice such as fasting, very-low-calorie eating or cutting out whole food groups. When you suggest foods, respect the user's diet type, allergies and disliked ingredients.

Return 2 to 4 insights. Each has a kind — "positive" (something this meal did well), "suggestion" (a concrete, gentle idea for this meal next time or for the rest of the day) or "watch" (something worth keeping an eye on) — a title of at most 6 words, and a body of 1-2 plain sentences addressed to the user as "you".`;

function fmt(value: number | undefined, unit: string): string {
  return value == null ? 'not set' : `${Math.round(value)} ${unit}`;
}

export function buildInsightsPrompt(ctx: MealInsightsContext): string {
  const { meal, dayTotals, goals, diet } = ctx;
  const lines = [
    `Meal (${meal.mealType}): ${meal.foods.map((f) => `${f.name} — ${f.portionLabel}, ${Math.round(f.calories)} kcal`).join('; ')}`,
    `Meal totals: ${fmt(meal.calories, 'kcal')}, protein ${fmt(meal.protein, 'g')}, carbs ${fmt(meal.carbs, 'g')}, fat ${fmt(meal.fats, 'g')}, fiber ${fmt(meal.fiber, 'g')}`,
    `That day so far (${ctx.mealsLoggedToday} meal${ctx.mealsLoggedToday === 1 ? '' : 's'} including this one): ${fmt(dayTotals.calories, 'kcal')}, protein ${fmt(dayTotals.protein, 'g')}, carbs ${fmt(dayTotals.carbs, 'g')}, fat ${fmt(dayTotals.fats, 'g')}, fiber ${fmt(dayTotals.fiber, 'g')}`,
    `Goal: ${goals?.goalType?.replace(/_/g, ' ') ?? 'not set'}`,
    `Daily targets: ${fmt(goals?.dailyCalorieTarget, 'kcal')}, protein ${fmt(goals?.proteinG, 'g')}, carbs ${fmt(goals?.carbsG, 'g')}, fat ${fmt(goals?.fatsG, 'g')}, fiber ${fmt(goals?.fiberG, 'g')}`,
    `Diet type: ${diet?.dietType && diet.dietType !== 'none' ? diet.dietType : 'no restriction'}`,
    `Allergies: ${diet?.allergies?.length ? diet.allergies.join(', ') : 'none listed'}`,
    `Disliked ingredients: ${diet?.dislikedIngredients?.length ? diet.dislikedIngredients.join(', ') : 'none listed'}`,
  ];
  return lines.join('\n');
}

/** Trims to at most 4 insights with sane lengths — the schema fixes the shape, this bounds the size shown in the app. */
export function sanitizeInsights(raw: z.infer<typeof insightsSchema>): MealInsight[] {
  return raw.insights
    .map((insight) => ({ kind: insight.kind, title: insight.title.trim().slice(0, 60), body: insight.body.trim().slice(0, 280) }))
    .filter((insight) => insight.title && insight.body)
    .slice(0, 4);
}

export async function generateMealInsights(ctx: MealInsightsContext): Promise<{ insights: MealInsight[]; model: string }> {
  const { ANTHROPIC_INSIGHTS_MODEL } = getAnthropicEnv();
  const raw = await callClaudeStructured({
    model: ANTHROPIC_INSIGHTS_MODEL,
    system: SYSTEM_PROMPT,
    content: [{ type: 'text', text: buildInsightsPrompt(ctx) }],
    schema: insightsSchema,
    maxTokens: 4000,
    effort: 'low',
    timeoutMs: 45_000,
  });
  return { insights: sanitizeInsights(raw), model: ANTHROPIC_INSIGHTS_MODEL };
}
