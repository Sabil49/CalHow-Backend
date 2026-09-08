import { describe, expect, it, vi } from 'vitest';
import { createUsdaNutritionLookupProvider, lookupUsdaMatchWithMetadata, type UsdaClientDeps } from '../usdaNutritionLookupProvider';
import { UsdaApiError } from '../usdaClient';
import {
  avocadoDetail,
  avocadoSearch,
  boiledEggDetail,
  boiledEggSearch,
  chickenBreastGrilledDetail,
  chickenBreastGrilledSearch,
  emptySearch,
  missingProteinDetail,
  missingProteinSearch,
  oliveOilDetail,
  oliveOilSearch,
  whiteRiceCookedDetail,
  whiteRiceCookedSearch,
} from './fixtures';
import type { UsdaFoodDetailResponse, UsdaSearchResponse, UsdaSearchResultItem } from '../types';

/** Builds a fake UsdaClientDeps that returns canned search/detail responses regardless of the query — enough to exercise the pipeline deterministically without live network access. */
function fakeDeps(
  searchResult: Awaited<ReturnType<UsdaClientDeps['search']>>,
  detailResult?: Awaited<ReturnType<UsdaClientDeps['getDetail']>>,
): UsdaClientDeps {
  return {
    search: vi.fn().mockResolvedValue(searchResult),
    searchUnfiltered: vi.fn().mockResolvedValue(emptySearch),
    getDetail: vi.fn().mockResolvedValue(detailResult),
  };
}

/**
 * Builds a UsdaClientDeps whose search function returns different responses
 * depending on whether the query contains a pattern key. Allows testing
 * fallback logic that triggers a second search with a modified query.
 *
 * @param responseMap - map of substring pattern → response; first match wins
 * @param defaultResponse - response when no pattern matches (initial query)
 */
function queryAwareDeps(
  responseMap: Record<string, UsdaSearchResponse>,
  defaultResponse: UsdaSearchResponse,
  detailResult: UsdaFoodDetailResponse,
): UsdaClientDeps {
  return {
    search: vi.fn().mockImplementation((query: string) => {
      const lower = query.toLowerCase();
      for (const [pattern, response] of Object.entries(responseMap)) {
        if (lower.includes(pattern)) return Promise.resolve(response);
      }
      return Promise.resolve(defaultResponse);
    }),
    searchUnfiltered: vi.fn().mockResolvedValue(emptySearch),
    getDetail: vi.fn().mockResolvedValue(detailResult),
  };
}

describe('USDA lookup provider — required test foods', () => {
  it('grilled chicken breast: resolves to the grilled entry, not raw or branded', async () => {
    const deps = fakeDeps(chickenBreastGrilledSearch, chickenBreastGrilledDetail);
    const provider = createUsdaNutritionLookupProvider(deps);
    const result = await provider.lookup('chicken breast grilled');

    expect(result).not.toBeNull();
    expect(result!.sourceId).toBe('171077');
    expect(result!.description).toContain('grilled');
    expect(result!.caloriesPer100g).toBe(165);
    expect(result!.proteinPer100g).toBe(31);
    expect(result!.fatsPer100g).toBe(3.6);
    expect(result!.carbsPer100g).toBe(0);
  });

  it('cooked white rice: resolves to the cooked entry', async () => {
    const deps = fakeDeps(whiteRiceCookedSearch, whiteRiceCookedDetail);
    const provider = createUsdaNutritionLookupProvider(deps);
    const result = await provider.lookup('white rice cooked');

    expect(result).not.toBeNull();
    expect(result!.caloriesPer100g).toBe(130);
    expect(result!.carbsPer100g).toBe(28.2);
  });

  it('avocado: resolves with real macros', async () => {
    const deps = fakeDeps(avocadoSearch, avocadoDetail);
    const provider = createUsdaNutritionLookupProvider(deps);
    const result = await provider.lookup('avocado');

    expect(result).not.toBeNull();
    expect(result!.caloriesPer100g).toBe(160);
    expect(result!.fatsPer100g).toBe(14.7);
    expect(result!.fiberPer100g).toBe(6.7);
  });

  it('olive oil: resolves with high-fat, zero-carb macros', async () => {
    const deps = fakeDeps(oliveOilSearch, oliveOilDetail);
    const provider = createUsdaNutritionLookupProvider(deps);
    const result = await provider.lookup('olive oil');

    expect(result).not.toBeNull();
    expect(result!.caloriesPer100g).toBe(884);
    expect(result!.fatsPer100g).toBe(100);
    expect(result!.carbsPer100g).toBe(0);
  });

  it('boiled egg: resolves to the boiled entry, not raw', async () => {
    const deps = fakeDeps(boiledEggSearch, boiledEggDetail);
    const provider = createUsdaNutritionLookupProvider(deps);
    const result = await provider.lookup('egg boiled');

    expect(result).not.toBeNull();
    expect(result!.description).toContain('hard-boiled');
    expect(result!.caloriesPer100g).toBe(155);
  });

  it('does not fabricate values when USDA search returns nothing', async () => {
    const deps = fakeDeps(emptySearch);
    const provider = createUsdaNutritionLookupProvider(deps);
    const result = await provider.lookup('a food that does not exist anywhere');
    expect(result).toBeNull();
  });

  it('does not fabricate values when the matched food is missing a required macro', async () => {
    const deps = fakeDeps(missingProteinSearch, missingProteinDetail);
    const provider = createUsdaNutritionLookupProvider(deps);
    const result = await provider.lookup('mystery food');
    expect(result).toBeNull();
  });

  it('lookupUsdaMatchWithMetadata exposes fdcId/description/dataType/score alongside the nutrition', async () => {
    const deps = fakeDeps(chickenBreastGrilledSearch, chickenBreastGrilledDetail);
    const result = await lookupUsdaMatchWithMetadata('chicken breast grilled', deps);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      fdcId: 171077,
      dataType: 'SR Legacy',
    });
    expect(result!.score).toBeGreaterThan(0);
    expect(result!.nutritionPer100g.caloriesPer100g).toBe(165);
  });
});

// ---------------------------------------------------------------------------
// Preparation-safe fallback (roasted → fried → cooked)
// ---------------------------------------------------------------------------

const friedCauliflowerSearch: UsdaSearchResponse = {
  totalHits: 1,
  foods: [{ fdcId: 8001, description: 'Fried cauliflower', dataType: 'Survey (FNDDS)', score: 300 }],
};
const cookedCauliflowerSearch: UsdaSearchResponse = {
  totalHits: 1,
  foods: [{ fdcId: 8002, description: 'Cauliflower, cooked, boiled, drained, without salt', dataType: 'SR Legacy', score: 250 }],
};
const cookedCauliflowerDetail: UsdaFoodDetailResponse = {
  fdcId: 8002,
  description: 'Cauliflower, cooked, boiled, drained, without salt',
  dataType: 'SR Legacy',
  foodNutrients: [
    { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 23 },
    { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 1.8 },
    { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 4.1 },
    { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0.2 },
  ],
};

describe('USDA lookup provider — preparation-safe fallback', () => {
  it('retries with a "cooked" search when the primary result is fried and query asks for roasted', async () => {
    const deps = queryAwareDeps(
      { cooked: cookedCauliflowerSearch },
      friedCauliflowerSearch,
      cookedCauliflowerDetail,
    );
    const result = await lookupUsdaMatchWithMetadata('roasted cauliflower roasted', deps);

    expect(result).not.toBeNull();
    expect(result!.description).toContain('boiled'); // cooked entry, not fried
    expect(deps.search).toHaveBeenCalledTimes(2);    // initial + fallback
  });

  it('returns null when every available candidate is fried and the query is roasted', async () => {
    // fakeDeps always returns fried — initial search and fallback both return it
    const deps = fakeDeps(friedCauliflowerSearch, cookedCauliflowerDetail);
    const result = await lookupUsdaMatchWithMetadata('roasted cauliflower roasted', deps);
    // tryPrepFallback also gets fried → isHighFatDesc → rejects it;
    // final guard then rejects fried for a roasted query
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Identity-conflict fallback (potato → pepper → component extraction)
// ---------------------------------------------------------------------------

const pepperSearch: UsdaSearchResponse = {
  totalHits: 1,
  foods: [{ fdcId: 9001, description: 'Peppers, sweet, green, sauteed', dataType: 'Survey (FNDDS)', score: 300 }],
};
const potatoSearch: UsdaSearchResponse = {
  totalHits: 1,
  foods: [{ fdcId: 9002, description: 'Potato, cooked, boiled, without skin', dataType: 'SR Legacy', score: 280 }],
};
const potatoDetail: UsdaFoodDetailResponse = {
  fdcId: 9002,
  description: 'Potato, cooked, boiled, without skin',
  dataType: 'SR Legacy',
  foodNutrients: [
    { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 86 },
    { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 1.9 },
    { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 20 },
    { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0.1 },
  ],
};

describe('USDA lookup provider — identity-conflict fallback', () => {
  it('extracts the first component and retries when the primary result has an identity conflict', async () => {
    // "potato and green bean curry sauteed" → USDA returns peppers (identity conflict:
    // potato ≠ pepper_vegetable); fallback splits on "and" → "potato sauteed" → potato entry
    const deps = queryAwareDeps(
      { potato: potatoSearch },
      pepperSearch,
      potatoDetail,
    );
    const result = await lookupUsdaMatchWithMetadata('potato and green bean curry sauteed', deps);

    expect(result).not.toBeNull();
    expect(result!.description).toContain('Potato');
    expect(result!.nutritionPer100g.caloriesPer100g).toBe(86);
  });

  it('returns null when the identity conflict cannot be resolved by any fallback', async () => {
    // Only peppers available — even the fallback gets a conflicting result
    const deps = fakeDeps(pepperSearch);
    const result = await lookupUsdaMatchWithMetadata('potato and green bean curry sauteed', deps);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Herb identity (mint → drumstick leaves → spearmint fallback)
// ---------------------------------------------------------------------------

const drumstickSearch: UsdaSearchResponse = {
  totalHits: 1,
  foods: [{ fdcId: 7001, description: 'Drumstick leaves, raw', dataType: 'Survey (FNDDS)', score: 300 }],
};
const spearmintSearch: UsdaSearchResponse = {
  totalHits: 1,
  foods: [{ fdcId: 7002, description: 'Spearmint, raw', dataType: 'SR Legacy', score: 280 }],
};
const spearmintDetail: UsdaFoodDetailResponse = {
  fdcId: 7002,
  description: 'Spearmint, raw',
  dataType: 'SR Legacy',
  foodNutrients: [
    { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 44 },
    { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 3.3 },
    { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 8.4 },
    { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0.7 },
  ],
};

describe('USDA lookup provider — herb identity fallback', () => {
  it('rejects drumstick leaves for a mint query and falls back to spearmint via keyword search', async () => {
    // "fresh mint leaves raw" → drumstick leaves (mint ≠ moringa conflict);
    // identity keyword fallback: category "mint" → keyword "mint" → query "mint raw"
    // The queryAwareDeps mock returns spearmintSearch when query contains "mint"
    // (the initial "fresh mint leaves raw" query ALSO contains "mint", so we
    // need to match on something more specific for the fallback)
    const deps: UsdaClientDeps = {
      search: vi.fn().mockImplementation((query: string) => {
        // Initial query is long ("fresh mint leaves raw"); fallback is short ("mint raw")
        if (query.toLowerCase() === 'mint raw') return Promise.resolve(spearmintSearch);
        return Promise.resolve(drumstickSearch);
      }),
      searchUnfiltered: vi.fn().mockResolvedValue(emptySearch),
      getDetail: vi.fn().mockResolvedValue(spearmintDetail),
    };

    const result = await lookupUsdaMatchWithMetadata('fresh mint leaves raw', deps);

    expect(result).not.toBeNull();
    expect(result!.description).toContain('Spearmint');
  });
});

// ---------------------------------------------------------------------------
// Detail-fetch availability fallback (candidate is semantically correct, but
// its specific USDA detail record is unavailable — live example: fdcId
// 331897, a valid "chicken, drumstick, meat only, cooked, braised" search
// result that 404s on GET /food/{id})
// ---------------------------------------------------------------------------

/** Two safe (non-conflicting) chicken-drumstick candidates plus one skin-only candidate that must never be used, for a plain "chicken drumstick" query (no skin mentioned). */
const skinOnlyCandidate: UsdaSearchResultItem = {
  fdcId: 6001,
  description: 'Chicken, skin (drumsticks and thighs), cooked, braised',
  dataType: 'SR Legacy',
  score: 500, // highest raw score, but -100 semantic penalty drops it below the safe candidates
};
const safeCandidateA: UsdaSearchResultItem = {
  fdcId: 6002,
  description: 'Chicken, broilers or fryers, drumstick, meat only, cooked, braised',
  dataType: 'Foundation',
  score: 450, // wins outright after skinOnlyCandidate's penalty (500-100=400 < 450)
};
const safeCandidateB: UsdaSearchResultItem = {
  fdcId: 6003,
  description: 'Chicken, dark meat, drumstick, meat only, with added solution, cooked, braised',
  dataType: 'SR Legacy',
  score: 300,
};

const drumstickSkinPlusSafeSearch: UsdaSearchResponse = {
  totalHits: 3,
  foods: [skinOnlyCandidate, safeCandidateA, safeCandidateB],
};

const safeCandidateADetail: UsdaFoodDetailResponse = {
  fdcId: safeCandidateA.fdcId,
  description: safeCandidateA.description,
  dataType: safeCandidateA.dataType,
  foodNutrients: [
    { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 149 },
    { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 23.93 },
    { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 0 },
    { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 5.95 },
  ],
};
const safeCandidateBDetail: UsdaFoodDetailResponse = {
  fdcId: safeCandidateB.fdcId,
  description: safeCandidateB.description,
  dataType: safeCandidateB.dataType,
  foodNutrients: [
    { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 155 },
    { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 24.5 },
    { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 0 },
    { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 6.2 },
  ],
};
const skinOnlyDetail: UsdaFoodDetailResponse = {
  fdcId: skinOnlyCandidate.fdcId,
  description: skinOnlyCandidate.description,
  dataType: skinOnlyCandidate.dataType,
  foodNutrients: [
    { nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 443 },
    { nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 14.72 },
    { nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 0 },
    { nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 42.76 },
  ],
};

describe('USDA lookup provider — detail-fetch availability fallback', () => {
  it('#1 falls back to the next semantically safe candidate when the top candidate detail 404s', async () => {
    const getDetail = vi.fn().mockImplementation(async (fdcId: number) => {
      if (fdcId === safeCandidateA.fdcId) throw new UsdaApiError('USDA FoodData Central food detail for fdcId 6002 failed with status 404.');
      if (fdcId === safeCandidateB.fdcId) return safeCandidateBDetail;
      throw new Error(`unexpected getDetail(${fdcId}) call in test`);
    });
    const deps: UsdaClientDeps = {
      search: vi.fn().mockResolvedValue(drumstickSkinPlusSafeSearch),
      searchUnfiltered: vi.fn().mockResolvedValue(emptySearch),
      getDetail,
    };

    const result = await lookupUsdaMatchWithMetadata('chicken drumstick', deps);

    expect(result).not.toBeNull();
    expect(result!.fdcId).toBe(safeCandidateB.fdcId);
    expect(result!.nutritionPer100g.caloriesPer100g).toBe(155);
    expect(getDetail).toHaveBeenCalledWith(safeCandidateA.fdcId);
    expect(getDetail).toHaveBeenCalledWith(safeCandidateB.fdcId);
  });

  it('#2 never fetches or uses the skin-only candidate as a fallback, even though its own detail record is available', async () => {
    const getDetail = vi.fn().mockImplementation(async (fdcId: number) => {
      if (fdcId === safeCandidateA.fdcId) throw new UsdaApiError('404');
      if (fdcId === safeCandidateB.fdcId) return safeCandidateBDetail;
      if (fdcId === skinOnlyCandidate.fdcId) return skinOnlyDetail; // available, but must never be chosen
      throw new Error(`unexpected getDetail(${fdcId}) call in test`);
    });
    const deps: UsdaClientDeps = {
      search: vi.fn().mockResolvedValue(drumstickSkinPlusSafeSearch),
      searchUnfiltered: vi.fn().mockResolvedValue(emptySearch),
      getDetail,
    };

    const result = await lookupUsdaMatchWithMetadata('chicken drumstick', deps);

    expect(result).not.toBeNull();
    expect(result!.fdcId).not.toBe(skinOnlyCandidate.fdcId);
    expect(result!.nutritionPer100g.caloriesPer100g).not.toBe(443);
    expect(getDetail).not.toHaveBeenCalledWith(skinOnlyCandidate.fdcId);
  });

  it('#3 returns null (nutrition_lookup_error at the caller) when every safe candidate fails detail/nutrient validation', async () => {
    const getDetail = vi.fn().mockImplementation(async (fdcId: number) => {
      if (fdcId === safeCandidateA.fdcId) throw new UsdaApiError('404');
      if (fdcId === safeCandidateB.fdcId) throw new UsdaApiError('404');
      if (fdcId === skinOnlyCandidate.fdcId) return skinOnlyDetail; // available, but never attempted — not a safe candidate
      throw new Error(`unexpected getDetail(${fdcId}) call in test`);
    });
    const deps: UsdaClientDeps = {
      search: vi.fn().mockResolvedValue(drumstickSkinPlusSafeSearch),
      searchUnfiltered: vi.fn().mockResolvedValue(emptySearch),
      getDetail,
    };

    const result = await lookupUsdaMatchWithMetadata('chicken drumstick', deps);

    expect(result).toBeNull();
    expect(getDetail).not.toHaveBeenCalledWith(skinOnlyCandidate.fdcId);
  });

  it('#4 uses the first candidate directly with no extra detail fetches when it succeeds (existing behavior unchanged)', async () => {
    const deps = fakeDeps(chickenBreastGrilledSearch, chickenBreastGrilledDetail);

    const result = await lookupUsdaMatchWithMetadata('chicken breast grilled', deps);

    expect(result).not.toBeNull();
    expect(result!.fdcId).toBe(171077);
    expect(result!.nutritionPer100g.caloriesPer100g).toBe(165);
    expect(deps.getDetail).toHaveBeenCalledTimes(1);
    expect(deps.getDetail).toHaveBeenCalledWith(171077);
  });
});
