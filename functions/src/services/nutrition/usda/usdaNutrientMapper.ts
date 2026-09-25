import type { UsdaDetailNutrient, UsdaNutrientEntry, UsdaSearchNutrient } from './types';

/**
 * USDA standard nutrient numbers (stable across data types/API versions —
 * more reliable to match on than nutrientId, which has had inconsistent
 * usage across USDA data sources historically). Source: USDA FoodData
 * Central's published nutrient reference.
 */
const NUTRIENT_NUMBERS = {
  ENERGY_KCAL: '208',
  PROTEIN: '203',
  FAT: '204',
  CARBS: '205',
  FIBER: '291',
} as const;

/** Fallback name-substring matches, used only if nutrientNumber is absent from the response entirely. */
const NUTRIENT_NAME_FALLBACKS: Record<keyof typeof NUTRIENT_NUMBERS, string> = {
  ENERGY_KCAL: 'energy',
  PROTEIN: 'protein',
  FAT: 'total lipid',
  CARBS: 'carbohydrate',
  FIBER: 'fiber',
};

export interface MappedNutrients {
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatsPer100g: number;
  fiberPer100g?: number;
}

interface FlatNutrient {
  number?: string;
  name?: string;
  unitName?: string;
  value?: number;
}

/** Normalizes either USDA nutrient shape (flat search-result or nested detail) into one flat shape. */
function flattenNutrientEntry(entry: UsdaNutrientEntry): FlatNutrient {
  const detail = entry as UsdaDetailNutrient;
  if (detail.nutrient) {
    return {
      number: detail.nutrient.number,
      name: detail.nutrient.name,
      unitName: detail.nutrient.unitName,
      value: detail.amount,
    };
  }
  const flat = entry as UsdaSearchNutrient;
  return {
    number: flat.nutrientNumber,
    name: flat.nutrientName,
    unitName: flat.unitName,
    value: flat.value,
  };
}

function findNutrientValue(flatNutrients: FlatNutrient[], key: keyof typeof NUTRIENT_NUMBERS): number | undefined {
  const targetNumber = NUTRIENT_NUMBERS[key];
  const byNumber = flatNutrients.find((n) => n.number === targetNumber);
  if (byNumber?.value != null) return byNumber.value;

  // Fallback: some entries omit nutrientNumber but always include a name.
  const nameSubstring = NUTRIENT_NAME_FALLBACKS[key];
  const byName = flatNutrients.find((n) => n.name?.toLowerCase().includes(nameSubstring));
  return byName?.value;
}

/**
 * Extracts calories/protein/carbs/fat/fiber (all per-100g, USDA's
 * standard reporting basis for Foundation/SR Legacy/Survey data) from a
 * raw USDA nutrient array.
 *
 * Returns `null` — not a partial/zero-filled object — if calories,
 * protein, carbs, or fat is missing, since those four are required
 * fields on NutritionFactsPer100g and this codebase does not fabricate a
 * value for a field it has no real data for (fiber remains optional and
 * is simply omitted when absent, since many real foods legitimately have
 * ~0g fiber and that's already representable as "not provided" via the
 * optional field rather than an invented number).
 */
export function mapUsdaNutrients(rawNutrients: UsdaNutrientEntry[] | undefined): MappedNutrients | null {
  if (!rawNutrients || rawNutrients.length === 0) return null;

  const flat = rawNutrients.map(flattenNutrientEntry);

  const caloriesPer100g = findNutrientValue(flat, 'ENERGY_KCAL');
  const proteinPer100g = findNutrientValue(flat, 'PROTEIN');
  const carbsPer100g = findNutrientValue(flat, 'CARBS');
  const fatsPer100g = findNutrientValue(flat, 'FAT');
  const fiberPer100g = findNutrientValue(flat, 'FIBER');

  if (caloriesPer100g == null || proteinPer100g == null || carbsPer100g == null || fatsPer100g == null) {
    return null;
  }

  return {
    caloriesPer100g,
    proteinPer100g,
    carbsPer100g,
    fatsPer100g,
    fiberPer100g,
  };
}
