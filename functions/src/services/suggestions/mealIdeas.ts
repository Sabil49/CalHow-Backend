import { z } from 'zod';
import { getAnthropicEnv } from '@/lib/env';
import { callClaudeStructured } from '@/services/ai/claudeClient';
import { estimateMenuDish, MAX_COMPONENTS_PER_DISH, type MenuDishResult } from '@/services/menu/menuScan';
import type { NutritionLookupProvider } from '@/services/nutrition/nutritionLookup';

/**
 * CalHow Pro "What Should I Eat Next?" — new meal ideas that fit what's
 * left of the user's day. Same split as the menu scanner: the model only
 * proposes dishes and what they're made of; each idea's nutrition is then
 * calculated from USDA through the shared scan pipeline, and ideas that
 * turn out not to fit the remaining calories are dropped.
 */

export const MEAL_IDEA_COUNT = 3;

const ideasSchema = z.object({
  ideas: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      components: z.array(z.object({ name: z.string(), preparation: z.string(), portionGrams: z.number() })),
    }),
  ),
});

export interface MealIdeasContext {
  remainingCalories: number;
  remainingProtein?: number;
  mealType: string;
  dietType?: string;
  allergies?: string[];
  dislikedIngredients?: string[];
}

const SYSTEM_PROMPT = `You suggest simple meal ideas for users of CalHow, a calorie tracking app, that fit what's left of their day.

Suggest ${MEAL_IDEA_COUNT + 1} different, realistic, everyday dishes someone could make or buy easily. For each one give a short name, a few words of description, and up to ${MAX_COMPONENTS_PER_DISH} main components, each a simple, database-friendly food name in English (e.g. "greek yogurt", "chicken breast", "cooked brown rice"), a single-word preparation method, and a portion in grams sized so the whole dish fits the calorie budget.

Report no calorie or nutrient values — those are calculated separately from your components. Respect the user's diet type, allergies and disliked ingredients strictly. Favor protein-rich options when the user still needs a lot of protein.`;

export function buildIdeasPrompt(ctx: MealIdeasContext): string {
  return [
    `Meal: ${ctx.mealType}`,
    `Calories left today: ${Math.round(ctx.remainingCalories)} kcal`,
    `Protein still needed today: ${ctx.remainingProtein != null ? `${Math.round(ctx.remainingProtein)} g` : 'no target'}`,
    `Diet type: ${ctx.dietType && ctx.dietType !== 'none' ? ctx.dietType : 'no restriction'}`,
    `Allergies: ${ctx.allergies?.length ? ctx.allergies.join(', ') : 'none listed'}`,
    `Disliked ingredients: ${ctx.dislikedIngredients?.length ? ctx.dislikedIngredients.join(', ') : 'none listed'}`,
  ].join('\n');
}

/** An idea fits when its USDA-calculated calories stay within the budget (with a little slack). */
export function fitsBudget(result: MenuDishResult, remainingCalories: number): boolean {
  return result.estimate != null && result.estimate.prediction.calories <= remainingCalories * 1.1;
}

export async function suggestMealIdeas(ctx: MealIdeasContext, lookupProvider: NutritionLookupProvider): Promise<MenuDishResult[]> {
  const { ANTHROPIC_INSIGHTS_MODEL } = getAnthropicEnv();
  const raw = await callClaudeStructured({
    model: ANTHROPIC_INSIGHTS_MODEL,
    system: SYSTEM_PROMPT,
    content: [{ type: 'text', text: buildIdeasPrompt(ctx) }],
    schema: ideasSchema,
    maxTokens: 6000,
    effort: 'low',
    timeoutMs: 45_000,
  });

  const candidates = raw.ideas.filter((idea) => idea.name.trim() && idea.components.length > 0).slice(0, MEAL_IDEA_COUNT + 1);
  const estimated = await Promise.all(
    candidates.map((idea) => estimateMenuDish({ ...idea, confidence: 0.8 }, ANTHROPIC_INSIGHTS_MODEL, lookupProvider)),
  );
  return estimated.filter((result) => fitsBudget(result, ctx.remainingCalories)).slice(0, MEAL_IDEA_COUNT);
}
