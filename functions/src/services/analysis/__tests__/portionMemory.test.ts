import { describe, expect, it, vi } from 'vitest';
import { buildPortionMemory, MAX_RATIO, memoryKey, type MemorySourceMeal } from '../portionMemory';
import { runAnalyzePipeline } from '../analyzePipeline';
import type { AiVisionResult, NutritionFactsPer100g } from '@/types/nutrition';
import type { FoodItem } from '@/types/models';

function food(id: string, name: string, portionGrams: number): FoodItem {
  return { id, name, portionLabel: `${portionGrams} g`, portionGrams, calories: 100 };
}

/** One saved meal where the AI said `aiGrams` of `name` and the user confirmed `finalGrams`. */
function meal(name: string, aiGrams: number, finalGrams: number, finalName = name): MemorySourceMeal {
  return { aiPrediction: { foods: [food('food-0', name, aiGrams)] }, foods: [food('food-0', finalName, finalGrams)] };
}

describe('buildPortionMemory', () => {
  it('learns a consistent correction (median of confirmed / AI grams)', () => {
    const memory = buildPortionMemory([meal('cooked white rice', 150, 225), meal('cooked white rice', 200, 300), meal('cooked white rice', 100, 140)]);
    expect(memory.get('cooked white rice')).toBe(1.5);
  });

  it('needs at least two observations', () => {
    expect(buildPortionMemory([meal('cooked white rice', 150, 300)]).size).toBe(0);
  });

  it('ignores small differences — portions kept as-is count as "the AI was right"', () => {
    const memory = buildPortionMemory([meal('rice', 150, 300), meal('rice', 150, 150), meal('rice', 150, 150)]);
    expect(memory.has('rice')).toBe(false);
  });

  it('clamps extreme ratios', () => {
    const memory = buildPortionMemory([meal('rice', 50, 500), meal('rice', 50, 400)]);
    expect(memory.get('rice')).toBe(MAX_RATIO);
  });

  it('ignores renamed foods (the AI got the food wrong, not the portion) and missing grams', () => {
    const memory = buildPortionMemory([
      meal('rice', 100, 200, 'quinoa'),
      meal('rice', 100, 200, 'quinoa'),
      { aiPrediction: { foods: [{ ...food('food-0', 'rice', 100), portionGrams: undefined }] }, foods: [food('food-0', 'rice', 200)] },
      { foods: [food('food-0', 'rice', 200)] },
    ]);
    expect(memory.size).toBe(0);
  });

  it('keys by case-insensitive name', () => {
    const memory = buildPortionMemory([meal('Cooked White Rice', 100, 150), meal('cooked white rice ', 100, 150)]);
    expect(memory.get(memoryKey('COOKED WHITE RICE'))).toBe(1.5);
  });
});

describe('runAnalyzePipeline with Smart Meal Memory', () => {
  const rice: NutritionFactsPer100g = {
    source: 'usda_fdc', sourceId: '1', description: 'rice', caloriesPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28, fatsPer100g: 0.3, matchScore: 0.9,
  };
  const aiResult: AiVisionResult = {
    detectedFoods: [{ rawName: 'cooked white rice', estimatedPortionGrams: 200, estimatedPortionLabel: '1 cup', detectionConfidence: 0.9 }],
    overallUncertainty: 0.1,
    modelVersion: 'test-model',
  };
  const deps = () => ({
    visionProvider: { analyzeMealImage: vi.fn().mockResolvedValue(aiResult) },
    lookupProvider: { lookup: vi.fn().mockResolvedValue(rice) },
  });

  it('scales a remembered food, labels it in grams and flags it', async () => {
    const plain = await runAnalyzePipeline({ imageBase64: 'x', mimeType: 'image/jpeg' }, deps());
    const name = plain.prediction.foods[0]!.name;
    expect(plain.prediction.foods[0]!.memoryAdjusted).toBeUndefined();

    const remembered = await runAnalyzePipeline(
      { imageBase64: 'x', mimeType: 'image/jpeg' },
      { ...deps(), portionMemory: new Map([[memoryKey(name), 1.5]]) },
    );
    const item = remembered.prediction.foods[0]!;
    expect(item.portionGrams).toBe(300);
    expect(item.portionLabel).toBe('300 g');
    expect(item.memoryAdjusted).toBe(true);
    expect(remembered.prediction.calories).toBe(Math.round(130 * 3));
  });

  it('leaves foods without a memory entry untouched', async () => {
    const result = await runAnalyzePipeline(
      { imageBase64: 'x', mimeType: 'image/jpeg' },
      { ...deps(), portionMemory: new Map([['something else', 1.5]]) },
    );
    expect(result.prediction.foods[0]!.portionGrams).toBe(200);
    expect(result.prediction.foods[0]!.portionLabel).toBe('1 cup');
  });
});
