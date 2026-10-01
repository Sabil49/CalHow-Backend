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
  /** Set on a "log again" copy of an earlier meal (calhow-mobile relogMeal) — its foods are that meal's, not a new AI estimate the user reviewed. */
  relogOf?: string;
  foods?: FoodItem[];
  aiPrediction?: { foods?: FoodItem[] };
}

/**
 * Preparation words the normalizer puts into food names ("banana smoothie
 * blended", "chicken thigh stir fried"). The AI picks these inconsistently
 * for the same food from scan to scan ("raw" one time, "blended" the next),
 * which split one food's corrections across several keys so it never
 * reached MIN_SAMPLES. Portion habits are about the food, not how it was
 * described, so they're left out of the key.
 */
const PREPARATION_WORDS = new Set([
  'raw', 'fresh', 'blended', 'cooked', 'uncooked', 'boiled', 'steamed', 'poached', 'grilled', 'fried', 'stir', 'deep',
  'sauteed', 'sautéed', 'roasted', 'baked', 'braised', 'toasted', 'smoked', 'plain', 'prepared', 'homemade',
]);

export function memoryKey(foodName: string): string {
  const words = foodName.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter(Boolean);
  const kept = words.filter((word) => !PREPARATION_WORDS.has(word));
  return (kept.length > 0 ? kept : words).join(' ');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function buildPortionMemory(meals: MemorySourceMeal[]): PortionMemory {
  const ratiosByFood = new Map<string, number[]>();

  for (const meal of meals) {
    // A re-logged copy repeats an earlier meal's AI estimate and the user's
    // edits to it; counting it would turn one correction into several.
    if (meal.relogOf) continue;
    const aiFoods = meal.aiPrediction?.foods ?? [];
    const finalById = new Map((meal.foods ?? []).map((food) => [food.id, food]));
    for (const aiFood of aiFoods) {
      const final = finalById.get(aiFood.id);
      // Only the same food, kept by the user (a rename means the AI got the
      // food itself wrong — not a portion signal).
      if (!final || memoryKey(final.name) !== memoryKey(aiFood.name)) continue;
      // Compare against the AI's OWN estimate. If memory already adjusted
      // this food, portionGrams is the adjusted value; learning from that
      // would treat an accepted adjustment as "the AI was right" and
      // gradually cancel the memory out.
      const aiGrams = aiFood.aiPortionGrams ?? aiFood.portionGrams;
      if (!aiGrams || !final.portionGrams || aiGrams <= 0 || final.portionGrams <= 0) continue;
      const key = memoryKey(aiFood.name);
      const ratios = ratiosByFood.get(key) ?? [];
      ratios.push(final.portionGrams / aiGrams);
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
