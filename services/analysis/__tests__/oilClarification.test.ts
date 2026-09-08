import { describe, expect, it, vi } from 'vitest';
import {
  calculateOilContribution,
  GENERIC_COOKING_OIL_QUERY,
  isOilAnswerLevel,
  isOilClarificationFoodId,
  OIL_GRAM_ASSUMPTIONS,
} from '../oilClarification';
import { ApiRouteError } from '@/lib/apiResponse';
import type { NutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import type { NutritionFactsPer100g } from '@/types/nutrition';

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

function fakeProvider(result: NutritionFactsPer100g | null): NutritionLookupProvider {
  return { lookup: vi.fn().mockResolvedValue(result) };
}

describe('OIL_GRAM_ASSUMPTIONS', () => {
  it('matches the approved V1 values exactly', () => {
    expect(OIL_GRAM_ASSUMPTIONS).toEqual({ none: 0, light: 5, regular: 14, heavy: 28 });
  });
});

describe('isOilAnswerLevel', () => {
  it('accepts the four known levels and rejects anything else', () => {
    expect(isOilAnswerLevel('none')).toBe(true);
    expect(isOilAnswerLevel('heavy')).toBe(true);
    expect(isOilAnswerLevel('extra-heavy')).toBe(false);
    expect(isOilAnswerLevel('')).toBe(false);
  });
});

describe('calculateOilContribution', () => {
  it('"none" contributes zero and skips the USDA lookup entirely', async () => {
    const provider = fakeProvider(genericOilNutrition);
    const { totals, foodItem } = await calculateOilContribution('none', provider);
    expect(totals).toEqual({ calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 });
    expect(foodItem).toBeNull();
    expect(provider.lookup).not.toHaveBeenCalled();
  });

  it('"light" (5g) scales the generic oil reference correctly and returns a food item', async () => {
    const provider = fakeProvider(genericOilNutrition);
    const { totals, foodItem } = await calculateOilContribution('light', provider);

    expect(provider.lookup).toHaveBeenCalledWith(GENERIC_COOKING_OIL_QUERY);
    expect(totals.calories).toBe(Math.round(884 * 0.05));
    expect(totals.fats).toBe(Math.round(100 * 0.05));
    expect(foodItem).not.toBeNull();
    expect(foodItem!.portionGrams).toBe(5);
    expect(foodItem!.portionLabel).toContain('5 g');
    expect(foodItem!.portionLabel).toContain('tsp');
  });

  it('"heavy" (28g) uses the same generic query and scales proportionally', async () => {
    const provider = fakeProvider(genericOilNutrition);
    const { totals } = await calculateOilContribution('heavy', provider);
    expect(totals.calories).toBe(Math.round(884 * 0.28));
  });

  it('uses a specific oil type\u2019s USDA entry when one is provided, instead of the generic query', async () => {
    const oliveOilNutrition: NutritionFactsPer100g = { ...genericOilNutrition, sourceId: '171413', description: 'Oil, olive' };
    const provider = fakeProvider(oliveOilNutrition);
    const { foodItem } = await calculateOilContribution('regular', provider, 'olive oil');

    const calledWith = (provider.lookup as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledWith).not.toBe(GENERIC_COOKING_OIL_QUERY);
    expect(calledWith).toContain('olive');
    expect(foodItem!.name).toContain('olive oil');
  });

  it('throws nutrition_lookup_error rather than fabricating a value when USDA has no oil match', async () => {
    const provider = fakeProvider(null);
    await expect(calculateOilContribution('regular', provider)).rejects.toThrowError(ApiRouteError);
  });

  it('stamps the food item id with the oil-clarification prefix recalculate relies on', async () => {
    const provider = fakeProvider(genericOilNutrition);
    const { foodItem } = await calculateOilContribution('light', provider);
    expect(isOilClarificationFoodId(foodItem!.id)).toBe(true);
  });
});

describe('isOilClarificationFoodId', () => {
  it('recognizes ids stamped by calculateOilContribution and rejects everything else', () => {
    expect(isOilClarificationFoodId('oil-clarification-light')).toBe(true);
    expect(isOilClarificationFoodId('oil-clarification-heavy')).toBe(true);
    expect(isOilClarificationFoodId('grilled-chicken-1')).toBe(false);
    expect(isOilClarificationFoodId('')).toBe(false);
  });
});
