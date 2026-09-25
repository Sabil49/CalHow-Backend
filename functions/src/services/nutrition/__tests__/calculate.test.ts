import { describe, expect, it } from 'vitest';
import { buildRecalculatedFoodItems, calculateFoodItemTotals, calculateMealTotalsFromMatches, calculateOverallConfidence, sumMealTotals } from '../calculate';
import type { FoodMatch, NutritionFactsPer100g } from '@/types/nutrition';
import type { FoodItem } from '@/types/models';

function per100g(overrides: Partial<NutritionFactsPer100g>): NutritionFactsPer100g {
  return {
    source: 'usda_fdc',
    sourceId: '1',
    description: 'test food',
    caloriesPer100g: 0,
    proteinPer100g: 0,
    carbsPer100g: 0,
    fatsPer100g: 0,
    ...overrides,
  };
}

describe('calculateFoodItemTotals — portion scaling', () => {
  it('grilled chicken breast, 150g', () => {
    const result = calculateFoodItemTotals(150, per100g({ caloriesPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatsPer100g: 3.6, fiberPer100g: 0 }));
    expect(result).toEqual({ calories: 248, protein: 47, carbs: 0, fats: 5, fiber: 0 });
  });

  it('cooked white rice, 200g', () => {
    const result = calculateFoodItemTotals(200, per100g({ caloriesPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28.2, fatsPer100g: 0.3, fiberPer100g: 0.4 }));
    expect(result).toEqual({ calories: 260, protein: 5, carbs: 56, fats: 1, fiber: 1 });
  });

  it('avocado, 100g (no scaling needed — factor is exactly 1)', () => {
    const result = calculateFoodItemTotals(100, per100g({ caloriesPer100g: 160, proteinPer100g: 2, carbsPer100g: 8.5, fatsPer100g: 14.7, fiberPer100g: 6.7 }));
    expect(result).toEqual({ calories: 160, protein: 2, carbs: 9, fats: 15, fiber: 7 });
  });

  it('olive oil, 10g (small portion of energy-dense food)', () => {
    const result = calculateFoodItemTotals(10, per100g({ caloriesPer100g: 884, proteinPer100g: 0, carbsPer100g: 0, fatsPer100g: 100, fiberPer100g: 0 }));
    expect(result).toEqual({ calories: 88, protein: 0, carbs: 0, fats: 10, fiber: 0 });
  });

  it('boiled egg, 50g', () => {
    const result = calculateFoodItemTotals(50, per100g({ caloriesPer100g: 155, proteinPer100g: 12.6, carbsPer100g: 1.1, fatsPer100g: 10.6, fiberPer100g: 0 }));
    expect(result).toEqual({ calories: 78, protein: 6, carbs: 1, fats: 5, fiber: 0 });
  });

  it('omits fiber when the source data has none', () => {
    const result = calculateFoodItemTotals(100, per100g({ caloriesPer100g: 100, proteinPer100g: 10, carbsPer100g: 5, fatsPer100g: 5 }));
    expect(result.fiber).toBeUndefined();
  });
});

describe('sumMealTotals / calculateMealTotalsFromMatches — determinism', () => {
  it('sums the 5 required foods into identical, deterministic meal totals across repeated calls', () => {
    const items = [
      calculateFoodItemTotals(150, per100g({ caloriesPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatsPer100g: 3.6, fiberPer100g: 0 })), // chicken
      calculateFoodItemTotals(200, per100g({ caloriesPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28.2, fatsPer100g: 0.3, fiberPer100g: 0.4 })), // rice
      calculateFoodItemTotals(100, per100g({ caloriesPer100g: 160, proteinPer100g: 2, carbsPer100g: 8.5, fatsPer100g: 14.7, fiberPer100g: 6.7 })), // avocado
      calculateFoodItemTotals(10, per100g({ caloriesPer100g: 884, proteinPer100g: 0, carbsPer100g: 0, fatsPer100g: 100, fiberPer100g: 0 })), // olive oil
      calculateFoodItemTotals(50, per100g({ caloriesPer100g: 155, proteinPer100g: 12.6, carbsPer100g: 1.1, fatsPer100g: 10.6, fiberPer100g: 0 })), // egg
    ];

    const runA = sumMealTotals(items);
    const runB = sumMealTotals([...items]); // fresh array, same values — proves no hidden mutation/state

    expect(runA).toEqual(runB);
    expect(runA.calories).toBe(248 + 260 + 160 + 88 + 78);
    expect(runA.fiber).toBe(0 + 1 + 7 + 0 + 0);
  });

  it('a food with no nutrition match (null) contributes zero, not a fabricated estimate', () => {
    const matches: FoodMatch[] = [
      { detectedName: 'chicken', normalizedName: 'chicken breast grilled', portionGrams: 150, nutrition: per100g({ caloriesPer100g: 165, proteinPer100g: 31, fatsPer100g: 3.6 }), matchConfidence: 0.9 },
      { detectedName: 'unknown food', normalizedName: 'unknown food', portionGrams: 100, nutrition: null, matchConfidence: 0 },
    ];
    const totals = calculateMealTotalsFromMatches(matches);
    // Only the matched chicken item contributes; the unmatched item adds exactly 0, not an invented value.
    expect(totals.calories).toBe(248);
  });
});

// ---------------------------------------------------------------------------
// buildRecalculatedFoodItems — the fix for the stale-calories consistency bug
// ---------------------------------------------------------------------------

describe('buildRecalculatedFoodItems — food/totals consistency invariant', () => {
  // Mirrors the real-device bug: dal edited from 350g to 390g; the stored
  // food still had the original AI-era 389 kcal figure.
  const dalNutrition = per100g({ caloriesPer100g: 111, proteinPer100g: 6.6, carbsPer100g: 20.0, fatsPer100g: 0.4, fiberPer100g: 3.9 });
  const oilNutrition = per100g({ caloriesPer100g: 884, proteinPer100g: 0, carbsPer100g: 0, fatsPer100g: 100 });

  const staleFoods: FoodItem[] = [
    { id: 'f1', name: 'dal', portionLabel: '350 g', portionGrams: 390, calories: 389 /* STALE — from original AI estimate at 350g */ },
    { id: 'f2', name: 'cooking oil', portionLabel: '14 g (~1 tbsp)', portionGrams: 21, calories: 126 /* STALE — label and calories both lag the edited grams */ },
  ];

  const matches: FoodMatch[] = [
    { detectedName: 'dal', normalizedName: 'dal cooked', portionGrams: 390, nutrition: dalNutrition, matchConfidence: 0.85 },
    { detectedName: 'cooking oil', normalizedName: 'olive oil', portionGrams: 21, nutrition: oilNutrition, matchConfidence: 0.9 },
  ];

  it('replaces stale food.calories with values derived from edited portionGrams × per-100g nutrition', () => {
    const result = buildRecalculatedFoodItems(staleFoods, matches);
    const expectedDalCalories = Math.round(111 * 390 / 100); // 433
    const expectedOilCalories = Math.round(884 * 21 / 100);  // 186
    expect(result[0].calories).toBe(expectedDalCalories);
    expect(result[0].calories).not.toBe(389); // stale value must be gone
    expect(result[1].calories).toBe(expectedOilCalories);
    expect(result[1].calories).not.toBe(126); // stale value must be gone
  });

  it('sum(foods[].calories) === returned total calories (no inconsistency)', () => {
    const result = buildRecalculatedFoodItems(staleFoods, matches);
    const totals = calculateMealTotalsFromMatches(matches);
    const sumFoodCalories = result.reduce((s, f) => s + f.calories, 0);
    expect(sumFoodCalories).toBe(totals.calories);
  });

  it('portionLabel is derived from portionGrams and cannot contradict it', () => {
    const result = buildRecalculatedFoodItems(staleFoods, matches);
    // oil was "14 g (~1 tbsp)" with portionGrams=21 — label must be updated
    expect(result[1].portionLabel).toBe('21 g');
    expect(result[1].portionGrams).toBe(21);
    // dal label was "350 g" but grams were edited to 390 — must be updated
    expect(result[0].portionLabel).toBe('390 g');
    expect(result[0].portionGrams).toBe(390);
  });

  it('preserves id, name, confidence, and imageUrl from the source food', () => {
    const withExtras: FoodItem[] = [
      { id: 'abc', name: 'dal', portionLabel: '350 g', portionGrams: 390, calories: 389, confidence: 0.82, imageUrl: 'file://photo.jpg' },
    ];
    const result = buildRecalculatedFoodItems(withExtras, [matches[0]!]);
    expect(result[0].id).toBe('abc');
    expect(result[0].name).toBe('dal');
    expect(result[0].confidence).toBe(0.82);
    expect(result[0].imageUrl).toBe('file://photo.jpg');
  });

  it('does not mutate the source foods array (original aiPrediction foods are unaffected)', () => {
    const source: FoodItem[] = [
      { id: 'f1', name: 'dal', portionLabel: '350 g', portionGrams: 390, calories: 389 },
    ];
    const originalCalories = source[0]!.calories;
    const originalLabel = source[0]!.portionLabel;
    buildRecalculatedFoodItems(source, [matches[0]!]);
    expect(source[0]!.calories).toBe(originalCalories);
    expect(source[0]!.portionLabel).toBe(originalLabel);
  });
});

describe('calculateOverallConfidence', () => {
  it('returns 0 when there are no matches', () => {
    expect(calculateOverallConfidence([], [])).toBe(0);
  });

  it('pulls the overall score down when one food has no match', () => {
    const matches: FoodMatch[] = [
      { detectedName: 'chicken', normalizedName: 'chicken', portionGrams: 150, nutrition: per100g({}), matchConfidence: 0.9 },
      { detectedName: 'mystery', normalizedName: 'mystery', portionGrams: 50, nutrition: null, matchConfidence: 0 },
    ];
    const confidence = calculateOverallConfidence(matches, [0.95, 0.9]);
    expect(confidence).toBeLessThan(0.95);
    expect(confidence).toBeGreaterThanOrEqual(0);
  });
});
