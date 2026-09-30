import { getAdminFirestore } from '@/lib/firebaseAdmin';
import type { FoodItem } from '@/types/models';

/**
 * CalHow Pro "Smart Meal Memory": learn how a user corrects the AI's
 * portion sizes and apply it to their future scans.
 *
 * Source: the user's own saved meals. Each keeps the untouched AI
 * prediction (`aiPrediction.foods`) next to what they confirmed (`foods`),
 * matched by food id — so for every food the AI detected and the user kept,
 * confirmedGrams / aiGrams says how far off the AI's portion was for them.
 * Portions kept as-is count too (ratio 1), so one-off edits don't outweigh
 * a history of the AI getting it right.
 *
 * A food is only adjusted with at least MIN_SAMPLES observations and a
 * median ratio at least MIN_EFFECT away from 1; the ratio is clamped to
 * [MIN_RATIO, MAX_RATIO] so memory can never swing a portion wildly. Only
 * portion GRAMS change — nutrition still comes from USDA for the new
 * weight, exactly as for any scan.
 */

export const MIN_SAMPLES = 2;
export const MIN_EFFECT = 0.1;
export const MIN_RATIO = 0.5;
export const MAX_RATIO = 2;
/** How many recent meals to learn from. */
export const MEMORY_MEAL_WINDOW = 100;

/** Normalized food name (lowercased) -> multiplier for the AI's portion estimate. */
export type PortionMemory = Map<string, number>;

export interface MemorySourceMeal {
  foods?: FoodItem[];
  aiPrediction?: { foods?: FoodItem[] };
}

export function memoryKey(foodName: string): string {
  return foodName.trim().toLowerCase();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function buildPortionMemory(meals: MemorySourceMeal[]): PortionMemory {
  const ratiosByFood = new Map<string, number[]>();

  for (const meal of meals) {
    const aiFoods = meal.aiPrediction?.foods ?? [];
    const finalById = new Map((meal.foods ?? []).map((food) => [food.id, food]));
    for (const aiFood of aiFoods) {
      const final = finalById.get(aiFood.id);
      // Only the same food, kept by the user (a rename means the AI got the
      // food itself wrong — not a portion signal).
      if (!final || memoryKey(final.name) !== memoryKey(aiFood.name)) continue;
      if (!aiFood.portionGrams || !final.portionGrams || aiFood.portionGrams <= 0 || final.portionGrams <= 0) continue;
      const key = memoryKey(aiFood.name);
      const ratios = ratiosByFood.get(key) ?? [];
      ratios.push(final.portionGrams / aiFood.portionGrams);
      ratiosByFood.set(key, ratios);
    }
  }

  const memory: PortionMemory = new Map();
  for (const [key, ratios] of ratiosByFood) {
    if (ratios.length < MIN_SAMPLES) continue;
    const ratio = median(ratios);
    if (Math.abs(ratio - 1) < MIN_EFFECT) continue;
    memory.set(key, Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)));
  }
  return memory;
}

/** Reads the user's recent meals (Admin SDK, own subcollection only) and builds their portion memory. */
export async function loadPortionMemory(uid: string): Promise<PortionMemory> {
  const snap = await getAdminFirestore()
    .collection('users')
    .doc(uid)
    .collection('meals')
    .orderBy('loggedAt', 'desc')
    .limit(MEMORY_MEAL_WINDOW)
    .get();
  return buildPortionMemory(snap.docs.map((doc) => doc.data() as MemorySourceMeal));
}
