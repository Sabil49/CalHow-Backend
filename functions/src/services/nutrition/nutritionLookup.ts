import { createUsdaNutritionLookupProvider } from './usda/usdaNutritionLookupProvider';
import type { NutritionFactsPer100g } from '@/types/nutrition';

/**
 * Nutrition database lookup — structured data is the source of truth for
 * calorie/macro numbers, never the AI (see the module doc comment in
 * services/ai/visionProvider.ts). USDA FoodData Central is the approved
 * V1 source: it's free, public, well-documented, and covers both raw
 * ingredients and many prepared/branded foods.
 *
 * Kept as an interface — not a USDA-specific export — so
 * services/foodMatching/foodMatcher.ts and any future caller depend on
 * "a nutrition lookup" rather than "USDA specifically". A second source
 * (e.g. a branded-food API, or a self-curated fallback dataset for
 * queries USDA misses) could implement the same interface later without
 * changing the matcher.
 */
export interface NutritionLookupProvider {
  /**
   * Looks up `normalizedName` (already cleaned up by a FoodNormalizer)
   * and returns the best-matching entry's per-100g nutrition facts, or
   * null if nothing sufficiently confident was found. Must never
   * fabricate approximate values when no real match exists — null is the
   * correct return, and callers (FoodMatcher) are responsible for
   * lowering confidence / triggering clarification in that case.
   */
  lookup(normalizedName: string): Promise<NutritionFactsPer100g | null>;
}

/**
 * Returns the USDA FoodData Central-backed implementation — see
 * services/nutrition/usda/usdaNutritionLookupProvider.ts for the actual
 * search -> match -> nutrient-extraction pipeline. USDA-specific code is
 * entirely contained under services/nutrition/usda/; nothing outside
 * that folder knows about USDA's request/response shapes.
 */
export function getNutritionLookupProvider(): NutritionLookupProvider {
  return createUsdaNutritionLookupProvider();
}
