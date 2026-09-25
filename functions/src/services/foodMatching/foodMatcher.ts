import { normalizeFoodDescription } from './normalizer';
import { GENERIC_COOKING_OIL_QUERY, isOilClarificationFoodId } from '@/services/analysis/oilClarification';
import type { AiDetectedFood, FoodItem, FoodMatch, NormalizerInput } from '@/types/nutrition';
import type { NutritionLookupProvider } from '@/services/nutrition/nutritionLookup';

/**
 * The explicit normalization + matching layer between raw AI output and
 * the nutrition database, per the approved pipeline:
 *
 *   AI detection -> [normalize] -> [USDA match] -> per-100g nutrition
 *
 * This exists as its own stage — not folded into the AI provider or the
 * nutrition lookup — because it's where AI text ("grilled chicken breast,
 * about a palm-sized piece") gets turned into something a structured
 * database can actually search on ("chicken breast, grilled, skinless")
 * plus a concrete gram estimate. That's meaningfully different work from
 * either "call the vision model" or "query USDA by exact term", and
 * keeping it separate means the matching *strategy* (e.g. fuzzy search,
 * synonym tables, embedding similarity) can change independently of both
 * neighbors.
 *
 * The normalizer's real implementation lives in ./normalizer.ts and
 * accepts `NormalizerInput` (types/nutrition.ts) — a shape both
 * AiDetectedFood (the analyze flow) and a user-edited mobile FoodItem
 * (the recalculate flow, via a small adapter) structurally satisfy, so
 * there is exactly one normalizer implementation, not two.
 */

export interface NormalizedFood {
  /** Cleaned-up/canonicalized search term, e.g. "chicken breast, grilled, skinless". */
  normalizedName: string;
  /** Best available gram estimate — from the AI's estimatedPortionGrams when present, otherwise a normalizer-specific fallback/heuristic. */
  portionGrams: number;
}

export interface FoodNormalizer {
  normalize(input: NormalizerInput): NormalizedFood;
}

export interface FoodMatcher {
  /**
   * Looks up `normalized` against the configured nutrition source (USDA
   * FoodData Central for V1, via NutritionLookupProvider) and returns a
   * FoodMatch. `nutrition` on the result is null — not a guess — when no
   * sufficiently confident match exists; see FoodMatch's doc comment in
   * types/nutrition.ts.
   */
  match(detectedName: string, normalized: NormalizedFood): Promise<FoodMatch>;
}

export function getFoodNormalizer(): FoodNormalizer {
  return { normalize: normalizeFoodDescription };
}

/**
 * Takes a NutritionLookupProvider (USDA, per the approved architecture)
 * as an explicit dependency rather than reaching for a global — makes
 * this trivially testable against a fake provider, and keeps this module
 * from importing/knowing about USDA specifics directly (the USDA
 * provider is the only thing that does, under services/nutrition/usda/).
 */
export function getFoodMatcher(lookupProvider: NutritionLookupProvider): FoodMatcher {
  return {
    async match(detectedName: string, normalized: NormalizedFood): Promise<FoodMatch> {
      const nutrition = await lookupProvider.lookup(normalized.normalizedName);
      return {
        detectedName,
        normalizedName: normalized.normalizedName,
        portionGrams: normalized.portionGrams,
        nutrition,
        // matchScore is populated by the USDA provider from its own
        // candidate-ranking margin (see usdaMatcher.ts); a lookup that
        // truly found nothing gets 0 confidence, not a guessed mid-value.
        matchConfidence: nutrition?.matchScore ?? 0,
      };
    },
  };
}

/**
 * Recalculate-flow entry point for one client-submitted `FoodItem`. Behaves
 * exactly like `matcher.match(food.name, normalizer.normalize(...))` for an
 * ordinary detected food — but for a clarification-generated oil item (see
 * `isOilClarificationFoodId`), the USDA query is pinned to
 * `GENERIC_COOKING_OIL_QUERY` instead of being re-derived from `food.name`.
 *
 * That override exists because `food.name` for these items is a display
 * label ("Cooking oil (estimated)"), not a nutritionally meaningful search
 * string — normalizing and searching on it directly can land on an
 * unrelated USDA entry (e.g. a cooking spray, mostly propellant/water)
 * instead of the plain oil reference the item was actually created from.
 * Pinning the query preserves the same authoritative nutrition identity
 * across an edit; `food.portionGrams`/`portionLabel` (the part the user
 * actually edits) still flows through normally, so scaling stays
 * deterministic per `calculateFoodItemTotals`.
 */
export function matchFoodForRecalculate(
  food: FoodItem,
  normalizer: FoodNormalizer,
  matcher: FoodMatcher,
): Promise<FoodMatch> {
  const normalized = normalizer.normalize({
    rawName: food.name,
    estimatedPortionGrams: food.portionGrams,
    estimatedPortionLabel: food.portionLabel,
  });

  if (isOilClarificationFoodId(food.id)) {
    return matcher.match(food.name, { normalizedName: GENERIC_COOKING_OIL_QUERY, portionGrams: normalized.portionGrams });
  }

  return matcher.match(food.name, normalized);
}

export type { AiDetectedFood };
