import { describe, expect, it } from 'vitest';
import { mapUsdaNutrients } from '../usdaNutrientMapper';
import { chickenBreastGrilledDetail, missingProteinDetail, oliveOilDetail } from './fixtures';

describe('mapUsdaNutrients', () => {
  it('extracts calories/protein/carbs/fat/fiber from the flat search-result nutrient shape', () => {
    const result = mapUsdaNutrients(chickenBreastGrilledDetail.foodNutrients);
    expect(result).toEqual({
      caloriesPer100g: 165,
      proteinPer100g: 31,
      carbsPer100g: 0,
      fatsPer100g: 3.6,
      fiberPer100g: 0,
    });
  });

  it('extracts nutrients from the nested detail-endpoint shape ({ nutrient: {...}, amount })', () => {
    const result = mapUsdaNutrients(oliveOilDetail.foodNutrients);
    expect(result).toEqual({
      caloriesPer100g: 884,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatsPer100g: 100,
      fiberPer100g: 0,
    });
  });

  it('returns null — not a partial or zero-filled object — when a required macro (protein) is missing', () => {
    const result = mapUsdaNutrients(missingProteinDetail.foodNutrients);
    expect(result).toBeNull();
  });

  it('returns null for an empty or undefined nutrient array', () => {
    expect(mapUsdaNutrients([])).toBeNull();
    expect(mapUsdaNutrients(undefined)).toBeNull();
  });

  it('omits fiber (not zero-fills it) when absent, since fiber is optional', () => {
    const noFiber = chickenBreastGrilledDetail.foodNutrients!.filter((n) => 'nutrientNumber' in n && n.nutrientNumber !== '291');
    const result = mapUsdaNutrients(noFiber);
    expect(result).not.toBeNull();
    expect(result!.fiberPer100g).toBeUndefined();
  });
});
