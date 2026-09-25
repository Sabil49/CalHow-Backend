import type { UsdaFoodDetailResponse, UsdaSearchResponse } from '../types';

/**
 * Fixture USDA responses for tests.
 *
 * IMPORTANT: these are approximate, illustrative per-100g values based on
 * well-known general nutrition reference figures (the kind widely quoted
 * for these foods), shaped to match USDA FoodData Central's documented
 * response format — NOT captured from a live API call. This sandbox's
 * network egress does not allow reaching api.nal.usda.gov (confirmed:
 * `curl` to it returns "host_not_allowed"), so nothing in this codebase
 * has been verified against a real USDA response. Treat these fixtures
 * as good-enough for exercising the pipeline's logic (mapping, matching,
 * scaling, summing), not as a substitute for a real integration test
 * against a live API key.
 */

export const chickenBreastGrilledSearch: UsdaSearchResponse = {
  totalHits: 3,
  foods: [
    {
      fdcId: 171077,
      description: 'Chicken, broilers or fryers, breast, meat only, cooked, grilled',
      dataType: 'SR Legacy',
      score: 420,
      foodNutrients: [
        { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 165 },
        { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 31 },
        { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 0 },
        { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 3.6 },
        { nutrientNumber: '291', nutrientName: 'Fiber, total dietary', unitName: 'G', value: 0 },
      ],
    },
    {
      fdcId: 171076,
      description: 'Chicken, broilers or fryers, breast, meat only, raw',
      dataType: 'SR Legacy',
      score: 410, // deliberately close/higher on raw base relevance, to prove the grilled-preference boost matters
      foodNutrients: [
        { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 120 },
        { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 22.5 },
        { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 0 },
        { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 2.6 },
      ],
    },
    {
      fdcId: 511992,
      description: "Tyson, Fully Cooked Grilled Chicken Breast Strips",
      dataType: 'Branded',
      score: 405,
      foodNutrients: [
        { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 110 },
        { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 22 },
        { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 1 },
        { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 2 },
      ],
    },
  ],
};

export const chickenBreastGrilledDetail: UsdaFoodDetailResponse = {
  fdcId: 171077,
  description: 'Chicken, broilers or fryers, breast, meat only, cooked, grilled',
  dataType: 'SR Legacy',
  foodNutrients: chickenBreastGrilledSearch.foods![0]!.foodNutrients,
};

export const whiteRiceCookedSearch: UsdaSearchResponse = {
  totalHits: 2,
  foods: [
    {
      fdcId: 168878,
      description: 'Rice, white, long-grain, regular, cooked',
      dataType: 'SR Legacy',
      score: 380,
      foodNutrients: [
        { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 130 },
        { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 2.7 },
        { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 28.2 },
        { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0.3 },
        { nutrientNumber: '291', nutrientName: 'Fiber, total dietary', unitName: 'G', value: 0.4 },
      ],
    },
    {
      fdcId: 169756,
      description: 'Rice, white, long-grain, regular, raw',
      dataType: 'SR Legacy',
      score: 375,
      foodNutrients: [
        { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 365 },
        { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 7.1 },
        { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 80 },
        { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0.7 },
      ],
    },
  ],
};

export const whiteRiceCookedDetail: UsdaFoodDetailResponse = {
  fdcId: 168878,
  description: 'Rice, white, long-grain, regular, cooked',
  dataType: 'SR Legacy',
  foodNutrients: whiteRiceCookedSearch.foods![0]!.foodNutrients,
};

export const avocadoSearch: UsdaSearchResponse = {
  totalHits: 1,
  foods: [
    {
      fdcId: 171705,
      description: 'Avocados, raw, all commercial varieties',
      dataType: 'SR Legacy',
      score: 300,
      foodNutrients: [
        { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 160 },
        { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 2 },
        { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 8.5 },
        { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 14.7 },
        { nutrientNumber: '291', nutrientName: 'Fiber, total dietary', unitName: 'G', value: 6.7 },
      ],
    },
  ],
};

export const avocadoDetail: UsdaFoodDetailResponse = {
  fdcId: 171705,
  description: 'Avocados, raw, all commercial varieties',
  dataType: 'SR Legacy',
  foodNutrients: avocadoSearch.foods![0]!.foodNutrients,
};

export const oliveOilSearch: UsdaSearchResponse = {
  totalHits: 1,
  foods: [
    {
      fdcId: 171413,
      description: 'Oil, olive, salad or cooking',
      dataType: 'SR Legacy',
      score: 350,
      foodNutrients: [
        { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 884 },
        { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 0 },
        { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 0 },
        { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 100 },
        { nutrientNumber: '291', nutrientName: 'Fiber, total dietary', unitName: 'G', value: 0 },
      ],
    },
  ],
};

export const oliveOilDetail: UsdaFoodDetailResponse = {
  fdcId: 171413,
  description: 'Oil, olive, salad or cooking',
  dataType: 'SR Legacy',
  // Detail endpoint modeled with the NESTED nutrient shape on purpose, to
  // exercise usdaNutrientMapper's handling of both response shapes.
  foodNutrients: [
    { type: 'FoodNutrient', nutrient: { number: '208', name: 'Energy', unitName: 'KCAL' }, amount: 884 },
    { type: 'FoodNutrient', nutrient: { number: '203', name: 'Protein', unitName: 'G' }, amount: 0 },
    { type: 'FoodNutrient', nutrient: { number: '205', name: 'Carbohydrate, by difference', unitName: 'G' }, amount: 0 },
    { type: 'FoodNutrient', nutrient: { number: '204', name: 'Total lipid (fat)', unitName: 'G' }, amount: 100 },
    { type: 'FoodNutrient', nutrient: { number: '291', name: 'Fiber, total dietary', unitName: 'G' }, amount: 0 },
  ],
};

export const boiledEggSearch: UsdaSearchResponse = {
  totalHits: 2,
  foods: [
    {
      fdcId: 172187,
      description: 'Egg, whole, cooked, hard-boiled',
      dataType: 'SR Legacy',
      score: 340,
      foodNutrients: [
        { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 155 },
        { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 12.6 },
        { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 1.1 },
        { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 10.6 },
        { nutrientNumber: '291', nutrientName: 'Fiber, total dietary', unitName: 'G', value: 0 },
      ],
    },
    {
      fdcId: 172186,
      description: 'Egg, whole, raw, fresh',
      dataType: 'SR Legacy',
      score: 335,
      foodNutrients: [
        { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 143 },
        { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 12.6 },
        { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 0.7 },
        { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 9.5 },
      ],
    },
  ],
};

export const boiledEggDetail: UsdaFoodDetailResponse = {
  fdcId: 172187,
  description: 'Egg, whole, cooked, hard-boiled',
  dataType: 'SR Legacy',
  foodNutrients: boiledEggSearch.foods![0]!.foodNutrients,
};

/** A search result whose detail response is missing protein entirely — used to prove missing nutrients are never fabricated. */
export const missingProteinSearch: UsdaSearchResponse = {
  totalHits: 1,
  foods: [{ fdcId: 999999, description: 'Mystery food, incomplete data', dataType: 'SR Legacy', score: 100, foodNutrients: [] }],
};

export const missingProteinDetail: UsdaFoodDetailResponse = {
  fdcId: 999999,
  description: 'Mystery food, incomplete data',
  dataType: 'SR Legacy',
  foodNutrients: [
    { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 200 },
    // protein (203) deliberately absent
    { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 10 },
    { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 5 },
  ],
};

export const emptySearch: UsdaSearchResponse = { totalHits: 0, foods: [] };
