import { describe, expect, it, vi } from 'vitest';
import { estimateMenuDishes, MAX_COMPONENTS_PER_DISH, MAX_MENU_DISHES, toVisionResult, type MenuAiResult } from '../menuScan';
import { ApiRouteError } from '@/lib/apiResponse';
import type { NutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import type { NutritionFactsPer100g } from '@/types/nutrition';

function facts(kcal: number): NutritionFactsPer100g {
  return { source: 'usda_fdc', sourceId: '1', description: 'x', caloriesPer100g: kcal, proteinPer100g: 10, carbsPer100g: 10, fatsPer100g: 5, matchScore: 0.9 };
}

/** Matches any query containing a known key; everything else has no USDA match. */
function lookup(entries: Record<string, NutritionFactsPer100g>): NutritionLookupProvider {
  return {
    lookup: vi.fn().mockImplementation(async (name: string) => {
      const key = Object.keys(entries).find((k) => name.includes(k));
      return key ? entries[key] : null;
    }),
  };
}

function dish(name: string, components: [string, number][], confidence = 0.8): MenuAiResult['dishes'][number] {
  return { name, description: '', confidence, components: components.map(([n, g]) => ({ name: n, preparation: 'cooked', portionGrams: g })) };
}

describe('toVisionResult', () => {
  it('turns a dish into the pipeline input, capping components', () => {
    const many = dish('Platter', Array.from({ length: 6 }, (_, i) => [`food ${i}`, 100] as [string, number]), 1.4);
    const result = toVisionResult(many, 'm');
    expect(result.detectedFoods).toHaveLength(MAX_COMPONENTS_PER_DISH);
    expect(result.detectedFoods[0]).toMatchObject({ rawName: 'food 0', estimatedPortionGrams: 100, detectionConfidence: 1 });
  });
});

describe('estimateMenuDishes', () => {
  it('estimates each dish through the shared pipeline', async () => {
    const results = await estimateMenuDishes(
      { isMenu: true, dishes: [dish('Chicken & Rice', [['chicken breast', 150], ['white rice', 200]])] },
      'm',
      lookup({ chicken: facts(165), rice: facts(130) }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Chicken & Rice');
    expect(results[0]!.estimate!.prediction.calories).toBe(Math.round(165 * 1.5) + Math.round(130 * 2));
  });

  it('reports a dish as unavailable (not partial) when a component has no USDA match, without failing the others', async () => {
    const results = await estimateMenuDishes(
      { isMenu: true, dishes: [dish('Mystery Stew', [['chicken breast', 150], ['unobtainium', 50]]), dish('Rice Bowl', [['white rice', 300]])] },
      'm',
      lookup({ chicken: facts(165), rice: facts(130) }),
    );
    expect(results[0]!.estimate).toBeUndefined();
    expect(results[0]!.unavailableReason).toBeTruthy();
    expect(results[1]!.estimate!.prediction.calories).toBe(390);
  });

  it('caps the number of dishes', async () => {
    const dishes = Array.from({ length: MAX_MENU_DISHES + 3 }, (_, i) => dish(`Dish ${i}`, [['white rice', 100]]));
    const results = await estimateMenuDishes({ isMenu: true, dishes }, 'm', lookup({ rice: facts(130) }));
    expect(results).toHaveLength(MAX_MENU_DISHES);
    expect(results.map((r) => r.name)).toEqual(dishes.slice(0, MAX_MENU_DISHES).map((d) => d.name));
  });

  it('rejects a photo that is not a menu', async () => {
    await expect(estimateMenuDishes({ isMenu: false, dishes: [] }, 'm', lookup({}))).rejects.toThrow(ApiRouteError);
  });
});
