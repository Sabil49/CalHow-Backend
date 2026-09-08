import { describe, expect, it, vi } from 'vitest';
import { getFoodMatcher, getFoodNormalizer, matchFoodForRecalculate } from '../foodMatcher';
import { calculateOilContribution, GENERIC_COOKING_OIL_QUERY } from '@/services/analysis/oilClarification';
import { calculateFoodItemTotals } from '@/services/nutrition/calculate';
import type { NutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import type { FoodItem, NutritionFactsPer100g } from '@/types/nutrition';

const genericOilNutrition: NutritionFactsPer100g = {
  source: 'usda_fdc',
  sourceId: '171412',
  description: 'Oil, vegetable, generic',
  caloriesPer100g: 884,
  proteinPer100g: 0,
  carbsPer100g: 0,
  fatsPer100g: 100,
  fiberPer100g: 0,
};

/** A USDA entry a generic "cooking oil" text search could plausibly land on instead — very different calorie density, standing in for the real bug (recalculate re-deriving a search string from the display label "Cooking oil (estimated)" instead of reusing the authoritative query). */
const wrongCookingOilMatch: NutritionFactsPer100g = {
  source: 'usda_fdc',
  sourceId: '999999',
  description: 'Cooking spray, vegetable oil',
  caloriesPer100g: 150,
  proteinPer100g: 0,
  carbsPer100g: 0,
  fatsPer100g: 16,
  fiberPer100g: 0,
};

function fakeProvider(byQuery: Record<string, NutritionFactsPer100g | null>): NutritionLookupProvider {
  return {
    lookup: vi.fn(async (query: string) => byQuery[query] ?? null),
  };
}

describe('matchFoodForRecalculate', () => {
  it('normalizes an ordinary food from its own name, as before', async () => {
    const provider = fakeProvider({ 'grilled chicken breast': genericOilNutrition });
    const normalizer = getFoodNormalizer();
    const matcher = getFoodMatcher(provider);
    const food: FoodItem = {
      id: 'food-1',
      name: 'grilled chicken breast',
      portionLabel: '150 g',
      portionGrams: 150,
      calories: 0,
    };

    const match = await matchFoodForRecalculate(food, normalizer, matcher);

    expect(provider.lookup).toHaveBeenCalledWith('grilled chicken breast');
    expect(match.portionGrams).toBe(150);
  });

  it('routes a clarification-generated oil item to the authoritative oil query, not a search derived from its display name', async () => {
    const provider = fakeProvider({
      [GENERIC_COOKING_OIL_QUERY]: genericOilNutrition,
      'cooking oil': wrongCookingOilMatch, // what a naive name-based re-search would hit
    });
    const normalizer = getFoodNormalizer();
    const matcher = getFoodMatcher(provider);
    const food: FoodItem = {
      id: 'oil-clarification-light',
      name: 'Cooking oil (estimated)',
      portionLabel: '6 g',
      portionGrams: 6,
      calories: 45, // stale client-sent value from before the edit — must not be trusted
    };

    const match = await matchFoodForRecalculate(food, normalizer, matcher);

    expect(provider.lookup).toHaveBeenCalledWith(GENERIC_COOKING_OIL_QUERY);
    expect(provider.lookup).not.toHaveBeenCalledWith('cooking oil');
    expect(match.nutrition).toEqual(genericOilNutrition);
    expect(match.portionGrams).toBe(6);
  });

  it('regression: clarification oil (5g) edited to 6g and recalculated scales deterministically off the same USDA identity, not the stale client calories', async () => {
    const provider = fakeProvider({ [GENERIC_COOKING_OIL_QUERY]: genericOilNutrition });

    // Step 1: clarification creates the 5g oil item (mirrors app/api/meals/clarify/route.ts).
    const { foodItem } = await calculateOilContribution('light', provider);
    expect(foodItem).not.toBeNull();
    expect(foodItem!.portionGrams).toBe(5);
    expect(foodItem!.calories).toBe(Math.round(884 * 0.05)); // 44

    // Step 2: user edits the portion to 6g; recalculate re-derives from scratch.
    const editedFood: FoodItem = { ...foodItem!, portionGrams: 6, portionLabel: '6 g' };
    const normalizer = getFoodNormalizer();
    const matcher = getFoodMatcher(provider);
    const match = await matchFoodForRecalculate(editedFood, normalizer, matcher);
    const totals = calculateFoodItemTotals(match.portionGrams, match.nutrition!);

    expect(totals.calories).toBe(Math.round(884 * 0.06)); // ~53, not 9
    expect(totals.calories).not.toBe(9);
  });
});
