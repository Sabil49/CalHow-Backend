import { z } from 'zod';
import { getAnthropicEnv } from '@/lib/env';
import { ApiRouteError } from '@/lib/apiResponse';
import { callClaudeStructured } from '@/services/ai/claudeClient';
import { runAnalyzePipeline, type AnalyzePipelineResult } from '@/services/analysis/analyzePipeline';
import type { NutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import type { VisionAnalysisInput } from '@/services/ai/visionProvider';
import type { AiVisionResult } from '@/types/nutrition';

/**
 * CalHow Pro "Restaurant & Menu Scanner".
 *
 * Step 1 (AI): read the menu photo and, for each dish, estimate what a
 * typical restaurant serving is made of — components and their weights.
 * Like the meal scanner, the model reports NO calories or macros.
 *
 * Step 2 (deterministic): each dish's components go through the exact
 * same pipeline as a meal photo's detected foods (runAnalyzePipeline:
 * normalization -> USDA match -> calculation -> clarification), so a
 * menu estimate uses the same nutrition source and rules as a scan. A dish
 * whose components can't all be matched reports no nutrition rather than
 * a partial one.
 */

/** Dishes per menu photo — each costs several USDA lookups, which share one API key. */
export const MAX_MENU_DISHES = 8;
export const MAX_COMPONENTS_PER_DISH = 4;
/** Dishes processed at the same time. */
const DISH_CONCURRENCY = 3;

const menuSchema = z.object({
  isMenu: z.boolean(),
  dishes: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      confidence: z.number(),
      components: z.array(
        z.object({
          name: z.string(),
          preparation: z.string(),
          portionGrams: z.number(),
        }),
      ),
    }),
  ),
});

export type MenuAiResult = z.infer<typeof menuSchema>;

const SYSTEM_PROMPT = `You read photos of restaurant menus for CalHow, a calorie tracking app, and describe what each dish would typically be made of, so the app can estimate its nutrition from a food database.

For each dish on the menu (up to ${MAX_MENU_DISHES}, in the order they appear; skip drinks, desserts only if space runs out, and section headings):
- name: the dish name as written on the menu.
- description: a few plain words about the dish in English, or an empty string.
- components: up to ${MAX_COMPONENTS_PER_DISH} main components of a typical single restaurant serving, each a simple, specific, database-friendly food name in English (e.g. "cooked white rice", "chicken breast", "naan bread", "cheddar cheese"), a single-word preparation method (e.g. "grilled", "fried", "boiled", "raw", "baked"), and your best estimate of its weight in grams. Use the menu's own description when it lists ingredients or sizes.
- confidence: 0 to 1, how sure you are about the components and portions.

Report no calories, protein, carbohydrate, fat or fiber values — those are calculated separately from your components.

If the photo is not a menu, set isMenu to false and return no dishes.`;

export interface MenuDishResult {
  name: string;
  description?: string;
  /** Set when nutrition was estimated; the dish can then be logged through the normal review flow. */
  estimate?: AnalyzePipelineResult;
  /** Set when it couldn't be (e.g. no reliable USDA match for a component). */
  unavailableReason?: string;
}

export function toVisionResult(dish: MenuAiResult['dishes'][number], modelVersion: string): AiVisionResult {
  const confidence = Math.min(1, Math.max(0, dish.confidence));
  return {
    detectedFoods: dish.components.slice(0, MAX_COMPONENTS_PER_DISH).map((component) => ({
      rawName: component.name,
      estimatedPortionGrams: component.portionGrams,
      preparationMethod: component.preparation || undefined,
      detectionConfidence: confidence,
    })),
    overallUncertainty: 1 - confidence,
    modelVersion,
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function readMenu(input: VisionAnalysisInput): Promise<{ menu: MenuAiResult; model: string }> {
  const { ANTHROPIC_MENU_MODEL } = getAnthropicEnv();
  const menu = await callClaudeStructured({
    model: ANTHROPIC_MENU_MODEL,
    system: SYSTEM_PROMPT,
    content: [
      { type: 'image', source: { type: 'base64', media_type: input.mimeType, data: input.imageBase64 } },
      { type: 'text', text: 'Read the dishes on this menu.' },
    ],
    schema: menuSchema,
    maxTokens: 8000,
    effort: 'low',
    timeoutMs: 75_000,
  });
  return { menu, model: ANTHROPIC_MENU_MODEL };
}

export async function estimateMenuDishes(
  menu: MenuAiResult,
  modelVersion: string,
  lookupProvider: NutritionLookupProvider,
): Promise<MenuDishResult[]> {
  const dishes = menu.dishes.filter((dish) => dish.name.trim() && dish.components.length > 0).slice(0, MAX_MENU_DISHES);
  if (!menu.isMenu || dishes.length === 0) {
    throw new ApiRouteError('invalid_request', 'No menu dishes were found in this photo. Please try again with a clear, well-lit photo of the menu.');
  }

  return mapWithConcurrency(dishes, DISH_CONCURRENCY, async (dish): Promise<MenuDishResult> => {
    const base = { name: dish.name.trim(), description: dish.description.trim() || undefined };
    try {
      const aiResult = toVisionResult(dish, modelVersion);
      const estimate = await runAnalyzePipeline(
        // The image was already read; this "provider" just hands the dish's components to the shared pipeline.
        { imageBase64: '', mimeType: 'image/jpeg' },
        { visionProvider: { analyzeMealImage: async () => aiResult }, lookupProvider },
      );
      return { ...base, estimate };
    } catch (err) {
      if (err instanceof ApiRouteError) {
        return { ...base, unavailableReason: "We couldn't find reliable nutrition data for this dish." };
      }
      throw err;
    }
  });
}
