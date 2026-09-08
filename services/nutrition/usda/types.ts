import type { NutritionFactsPer100g } from '@/types/nutrition';

/**
 * USDA FoodData Central API response shapes.
 *
 * USDA's `/foods/search` and `/food/{fdcId}` endpoints return nutrients
 * in two DIFFERENT shapes:
 *   - search results: a flatter `{ nutrientId, nutrientName, nutrientNumber, unitName, value }`
 *   - food detail: a nested `{ nutrient: { id, number, name, unitName }, amount }`
 * usdaNutrientMapper.ts handles both defensively. These types model both.
 *
 * DELIBERATE LIMITATION — Branded foods / labelNutrients: USDA's Branded
 * data type often reports nutrition via a THIRD shape, `labelNutrients`
 * (e.g. `{ fat: { value }, protein: { value }, ... }`), which is
 * PER SERVING, not per-100g — converting it correctly requires reading
 * `servingSize`/`servingSizeUnit` and handling unit variations (g, ml,
 * oz, "1 container", etc.) correctly. That conversion is NOT implemented
 * here. This codebase only extracts nutrition from `foodNutrients`
 * (present for Foundation/SR Legacy/Survey, and often also present for
 * Branded entries via the detail endpoint) — if a matched food has only
 * `labelNutrients` and no usable `foodNutrients`, `mapUsdaNutrients`
 * correctly returns null (see usdaNutrientMapper.ts) rather than
 * attempting an unverified serving-to-100g conversion. This is a real
 * coverage gap for some packaged/branded foods, accepted deliberately
 * rather than shipping unverified conversion math — see the USDA
 * integration report for the decision to keep this deferred.
 *
 * NOTE: these shapes are modeled from USDA's published API documentation
 * (https://fdc.nal.usda.gov/api-guide.html), not verified against a live
 * call — this sandbox's network egress doesn't allow reaching
 * api.nal.usda.gov. See scripts/usdaSmokeTest.ts for a local live
 * verification procedure.
 */

export interface UsdaSearchNutrient {
  nutrientId?: number;
  nutrientName?: string;
  nutrientNumber?: string;
  unitName?: string;
  value?: number;
}

export interface UsdaDetailNutrient {
  type?: string;
  id?: number;
  nutrient?: {
    id?: number;
    number?: string;
    name?: string;
    unitName?: string;
  };
  amount?: number;
}

/** Either shape a nutrient entry might arrive in — usdaNutrientMapper.ts normalizes both. */
export type UsdaNutrientEntry = UsdaSearchNutrient | UsdaDetailNutrient;

export interface UsdaSearchResultItem {
  fdcId: number;
  description: string;
  dataType?: string;
  /** USDA's own relevance score for this query — higher is better. Only present on search results, not food detail. */
  score?: number;
  foodNutrients?: UsdaNutrientEntry[];
}

export interface UsdaSearchResponse {
  totalHits?: number;
  foods?: UsdaSearchResultItem[];
}

/** Response shape of GET /food/{fdcId} — full nutrient profile for one food. */
export interface UsdaFoodDetailResponse {
  fdcId: number;
  description: string;
  dataType?: string;
  foodNutrients?: UsdaNutrientEntry[];
}

/**
 * Full internal match result, including metadata not exposed through the
 * public NutritionLookupProvider interface's return type — kept here so
 * it's available for logging/debugging/future use without bloating the
 * interface every caller has to deal with.
 */
export interface UsdaMatchResult {
  fdcId: number;
  description: string;
  dataType: string;
  /** 0-1, normalized. See usdaMatcher.ts for how raw USDA scores + heuristic boosts become this. */
  score: number;
  nutritionPer100g: NutritionFactsPer100g;
}
