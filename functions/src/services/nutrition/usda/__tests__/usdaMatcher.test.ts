import { describe, expect, it } from 'vitest';
import { detectEdiblePartQualifier, detectFoodIdentityCategory, pickBestUsdaMatch } from '../usdaMatcher';
import type { UsdaSearchResultItem } from '../types';
import { boiledEggSearch, chickenBreastGrilledSearch, whiteRiceCookedSearch } from './fixtures';

describe('pickBestUsdaMatch', () => {
  it('prefers cooked/grilled chicken breast over raw chicken and a branded product for "grilled chicken breast"', () => {
    const result = pickBestUsdaMatch(chickenBreastGrilledSearch.foods!, { preparationHint: 'grilled' });
    expect(result).not.toBeNull();
    expect(result!.candidate.description).toBe('Chicken, broilers or fryers, breast, meat only, cooked, grilled');
    expect(result!.candidate.dataType).not.toBe('Branded');
  });

  it('prefers cooked rice over raw rice when the query implies cooked', () => {
    const result = pickBestUsdaMatch(whiteRiceCookedSearch.foods!, { preparationHint: 'cooked' });
    expect(result!.candidate.description).toContain('cooked');
  });

  it('prefers boiled egg over raw egg when the query says boiled', () => {
    const result = pickBestUsdaMatch(boiledEggSearch.foods!, { preparationHint: 'boiled' });
    expect(result!.candidate.description).toContain('hard-boiled');
  });

  it('falls back to USDA relevance order when no preparation hint is given (e.g. "avocado")', () => {
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Avocados, raw, all commercial varieties', dataType: 'SR Legacy', score: 300 }],
      {},
    );
    expect(result!.candidate.fdcId).toBe(1);
  });

  it('returns null for an empty candidate list', () => {
    expect(pickBestUsdaMatch([], {})).toBeNull();
  });

  it('returns a confidence between 0 and 1', () => {
    const result = pickBestUsdaMatch(chickenBreastGrilledSearch.foods!, { preparationHint: 'grilled' });
    expect(result!.confidence).toBeGreaterThan(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Food-identity semantic guard (proteins, vegetables, herbs)
// ---------------------------------------------------------------------------

describe('detectFoodIdentityCategory', () => {
  it('detects protein categories', () => {
    expect(detectFoodIdentityCategory('grilled chicken breast')).toBe('chicken');
    expect(detectFoodIdentityCategory('Stir fried beef and vegetables')).toBe('beef');
    expect(detectFoodIdentityCategory('paneer cubes')).toBe('paneer');
    expect(detectFoodIdentityCategory('yellow lentil dal')).toBe('legume');
  });

  it('detects vegetable categories', () => {
    expect(detectFoodIdentityCategory('potato and green bean curry')).toBe('potato');
    expect(detectFoodIdentityCategory('Peppers, sweet, green, sauteed')).toBe('pepper_vegetable');
    expect(detectFoodIdentityCategory('cauliflower roasted')).toBe('cauliflower');
    expect(detectFoodIdentityCategory('Cauliflower, raw')).toBe('cauliflower');
    expect(detectFoodIdentityCategory('spinach cooked')).toBe('spinach');
  });

  it('detects herb categories', () => {
    expect(detectFoodIdentityCategory('fresh mint leaves raw')).toBe('mint');
    expect(detectFoodIdentityCategory('Spearmint, raw')).toBe('mint');
    expect(detectFoodIdentityCategory('Drumstick leaves, raw')).toBe('moringa');
  });

  it('returns undefined when no identifiable category is present', () => {
    expect(detectFoodIdentityCategory('white rice cooked')).toBeUndefined();
    expect(detectFoodIdentityCategory('olive oil')).toBeUndefined();
    expect(detectFoodIdentityCategory('mixed vegetables')).toBeUndefined();
  });

  it('does not false-positive on substrings: "egg" must not match "eggplant"', () => {
    expect(detectFoodIdentityCategory('Eggplant, cooked, boiled')).toBeUndefined();
  });

  it('does not false-positive on "peppers" keyword matching "Pepper, black" spice', () => {
    expect(detectFoodIdentityCategory('Pepper, black')).toBeUndefined();
  });

  it('proteins take priority over vegetables when both are present ("palak paneer")', () => {
    expect(detectFoodIdentityCategory('palak paneer')).toBe('paneer');
  });
});

describe('pickBestUsdaMatch — food-identity semantic guard', () => {
  const paneerId = 9001;
  const beefId = 9002;

  const paneerCandidate: UsdaSearchResultItem = {
    fdcId: paneerId,
    description: 'Paneer, raw',
    dataType: 'SR Legacy',
    score: 200,
  };
  const beefCandidate: UsdaSearchResultItem = {
    fdcId: beefId,
    description: 'Stir fried beef and vegetables in soy sauce',
    dataType: 'Survey (FNDDS)',
    score: 250, // higher USDA relevance score, but wrong protein
  };

  it('penalises a beef candidate so a paneer candidate wins when query says "paneer"', () => {
    const result = pickBestUsdaMatch([beefCandidate, paneerCandidate], {
      queryText: 'vegetable fried rice with paneer',
    });
    expect(result).not.toBeNull();
    expect(result!.candidate.fdcId).toBe(paneerId);
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('sets hasSemanticConflict when the only available candidate has the wrong protein', () => {
    const result = pickBestUsdaMatch([beefCandidate], {
      queryText: 'vegetable fried rice with paneer',
    });
    expect(result).not.toBeNull();
    expect(result!.hasSemanticConflict).toBe(true);
  });

  it('does not set hasSemanticConflict when proteins match', () => {
    const result = pickBestUsdaMatch(chickenBreastGrilledSearch.foods!, {
      preparationHint: 'grilled',
      queryText: 'chicken breast grilled',
    });
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('does not set hasSemanticConflict when the USDA description has no identifiable category', () => {
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Rice, white, cooked', dataType: 'SR Legacy', score: 300 }],
      { queryText: 'vegetable fried rice with paneer' },
    );
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('sets hasSemanticConflict when "potato" query matches "Peppers, sweet, green"', () => {
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Peppers, sweet, green, sauteed', dataType: 'Survey (FNDDS)', score: 300 }],
      { queryText: 'potato and green bean curry sauteed' },
    );
    expect(result!.hasSemanticConflict).toBe(true);
  });

  it('does not set hasSemanticConflict when potato query matches a potato entry', () => {
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Potato, cooked, boiled, without skin', dataType: 'SR Legacy', score: 300 }],
      { queryText: 'potato and green bean curry sauteed' },
    );
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('does not set hasSemanticConflict when cauliflower query matches cauliflower entry', () => {
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Cauliflower, raw', dataType: 'Foundation', score: 300 }],
      { queryText: 'roasted cauliflower' },
    );
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('sets hasSemanticConflict when "mint" query matches drumstick leaves (moringa)', () => {
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Drumstick leaves, raw', dataType: 'Survey (FNDDS)', score: 300 }],
      { queryText: 'fresh mint leaves raw' },
    );
    expect(result!.hasSemanticConflict).toBe(true);
  });

  it('does not set hasSemanticConflict when "mint" query matches spearmint', () => {
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Spearmint, raw', dataType: 'SR Legacy', score: 300 }],
      { queryText: 'fresh mint leaves raw' },
    );
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('does not conflict when USDA description has no identifiable category ("Mixed vegetables")', () => {
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Mixed vegetables, cooked', dataType: 'SR Legacy', score: 300 }],
      { queryText: 'potato and green bean curry' },
    );
    expect(result!.hasSemanticConflict).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edible-part qualifier guard (skin-only vs meat-only/meat-and-skin/whole)
// ---------------------------------------------------------------------------

describe('detectEdiblePartQualifier', () => {
  it('classifies "skin" alone as skin-only', () => {
    expect(detectEdiblePartQualifier('Chicken, skin (drumsticks and thighs), cooked, braised')).toBe('skin-only');
    expect(detectEdiblePartQualifier('chicken skin')).toBe('skin-only');
  });

  it('classifies "meat" alone as meat-only', () => {
    expect(detectEdiblePartQualifier('Chicken, drumstick, meat only, cooked, braised')).toBe('meat-only');
  });

  it('classifies "skin" + "meat" together as meat-and-skin', () => {
    expect(detectEdiblePartQualifier('Chicken, drumstick, meat and skin, cooked, braised')).toBe('meat-and-skin');
  });

  it('classifies plain cut names with neither token as unspecified', () => {
    expect(detectEdiblePartQualifier('chicken drumstick')).toBe('unspecified');
    expect(detectEdiblePartQualifier('chicken pieces')).toBe('unspecified');
    expect(detectEdiblePartQualifier('chicken')).toBe('unspecified');
  });

  it('does not false-positive "skinless" as skin-only', () => {
    expect(detectEdiblePartQualifier('Chicken, breast, skinless, boneless, meat only, cooked, grilled')).toBe('meat-only');
  });

  it('does not false-positive "without skin" / "no skin" as skin-only (skin explicitly excluded)', () => {
    expect(detectEdiblePartQualifier('Potato, cooked, boiled, without skin')).toBe('unspecified');
    expect(detectEdiblePartQualifier('Chicken, breast, no skin, roasted')).toBe('unspecified');
  });
});

describe('pickBestUsdaMatch — edible-part qualifier guard', () => {
  const skinOnlyCandidate: UsdaSearchResultItem = {
    fdcId: 7001,
    description: 'Chicken, skin (drumsticks and thighs), cooked, braised',
    dataType: 'SR Legacy',
    score: 300,
  };
  const meatAndSkinCandidate: UsdaSearchResultItem = {
    fdcId: 7002,
    description: 'Chicken, drumstick, meat and skin, cooked, braised',
    dataType: 'SR Legacy',
    score: 280,
  };
  const meatOnlyCandidate: UsdaSearchResultItem = {
    fdcId: 7003,
    description: 'Chicken, drumstick, meat only, cooked, braised',
    dataType: 'SR Legacy',
    score: 270,
  };

  it('rejects a skin-only candidate for "chicken drumstick"', () => {
    const result = pickBestUsdaMatch([skinOnlyCandidate], { queryText: 'chicken drumstick braised', preparationHint: 'braised' });
    expect(result!.hasSemanticConflict).toBe(true);
  });

  it('rejects a skin-only candidate for "chicken pieces"', () => {
    const result = pickBestUsdaMatch([skinOnlyCandidate], { queryText: 'chicken pieces braised', preparationHint: 'braised' });
    expect(result!.hasSemanticConflict).toBe(true);
  });

  it('rejects a skin-only candidate for plain "chicken"', () => {
    const result = pickBestUsdaMatch([skinOnlyCandidate], { queryText: 'chicken braised', preparationHint: 'braised' });
    expect(result!.hasSemanticConflict).toBe(true);
  });

  it('accepts a skin-only candidate when the query itself asks for skin', () => {
    const result = pickBestUsdaMatch([skinOnlyCandidate], { queryText: 'chicken skin braised', preparationHint: 'braised' });
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('accepts a meat-and-skin candidate for "chicken drumstick"', () => {
    const result = pickBestUsdaMatch([meatAndSkinCandidate], { queryText: 'chicken drumstick braised', preparationHint: 'braised' });
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('accepts a meat-only candidate for "chicken drumstick"', () => {
    const result = pickBestUsdaMatch([meatOnlyCandidate], { queryText: 'chicken drumstick braised', preparationHint: 'braised' });
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('prefers the meat-and-skin candidate over the skin-only candidate for "chicken drumstick" when both are returned', () => {
    const result = pickBestUsdaMatch([skinOnlyCandidate, meatAndSkinCandidate], {
      queryText: 'chicken drumstick braised',
      preparationHint: 'braised',
    });
    expect(result!.candidate.fdcId).toBe(meatAndSkinCandidate.fdcId);
    expect(result!.hasSemanticConflict).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coarse food-family semantic guard
// ---------------------------------------------------------------------------

describe('pickBestUsdaMatch — coarse food-family semantic guard', () => {
  const chickenWingCandidate: UsdaSearchResultItem = {
    fdcId: 5001,
    description: 'Chicken wing, sauteed',
    dataType: 'Survey (FNDDS)',
    score: 300, // higher USDA relevance, but wrong family
  };
  const carrotsCandidate: UsdaSearchResultItem = {
    fdcId: 5002,
    description: 'Carrots, cooked, boiled, drained',
    dataType: 'SR Legacy',
    score: 220, // lower raw score, wins after chicken's -100 family penalty (300-100=200 < 220)
  };

  it('sets hasSemanticConflict when a vegetable query matches a meat candidate', () => {
    const result = pickBestUsdaMatch([chickenWingCandidate], {
      queryText: 'mixed carrots and beans sauteed',
    });
    expect(result!.hasSemanticConflict).toBe(true);
  });

  it('penalises the meat candidate so a vegetable candidate wins for a vegetable query', () => {
    const result = pickBestUsdaMatch([chickenWingCandidate, carrotsCandidate], {
      queryText: 'mixed carrots and beans sauteed',
    });
    expect(result!.candidate.fdcId).toBe(carrotsCandidate.fdcId);
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('sets hasSemanticConflict when a grain query matches a meat-only candidate (rice → chicken wing)', () => {
    const result = pickBestUsdaMatch([chickenWingCandidate], {
      queryText: 'vegetable fried rice fried',
    });
    expect(result!.hasSemanticConflict).toBe(true);
  });

  it('does NOT set hasSemanticConflict when description shares the grain family with a grain query (rice paper roll)', () => {
    // "Roll with meat and/or shrimp, rice paper" contains 'rice' (grain) which
    // the query "vegetable fried rice" also has — shared family exemption applies.
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Roll with meat and/or shrimp, vegetables and rice paper, not fried', dataType: 'Survey (FNDDS)', score: 300 }],
      { queryText: 'vegetable fried rice fried' },
    );
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('does not conflict for same-family: vegetable query vs vegetable candidate', () => {
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Carrots, cooked, boiled, drained', dataType: 'SR Legacy', score: 300 }],
      { queryText: 'mixed carrots and beans sauteed' },
    );
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('does not conflict for same-family: grain query vs grain candidate', () => {
    const result = pickBestUsdaMatch(
      [{ fdcId: 1, description: 'Rice, white, cooked, enriched', dataType: 'SR Legacy', score: 300 }],
      { queryText: 'white rice cooked' },
    );
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('does not conflict for same-family: meat query vs meat candidate', () => {
    const result = pickBestUsdaMatch(chickenBreastGrilledSearch.foods!, {
      preparationHint: 'grilled',
      queryText: 'chicken breast grilled',
    });
    expect(result!.hasSemanticConflict).toBe(false);
  });

  it('existing paneer/beef specific-identity guard remains working alongside family guard', () => {
    const paneerCandidate: UsdaSearchResultItem = { fdcId: 9001, description: 'Paneer, raw', dataType: 'SR Legacy', score: 200 };
    const beefCandidate: UsdaSearchResultItem = { fdcId: 9002, description: 'Stir fried beef and vegetables in soy sauce', dataType: 'Survey (FNDDS)', score: 250 };

    const result = pickBestUsdaMatch([beefCandidate, paneerCandidate], {
      queryText: 'vegetable fried rice with paneer',
    });
    expect(result!.candidate.fdcId).toBe(paneerCandidate.fdcId);
    expect(result!.hasSemanticConflict).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Calorie-significant preparation mismatch (roasted/grilled → fried)
// ---------------------------------------------------------------------------

describe('pickBestUsdaMatch — preparation mismatch penalty', () => {
  const roastedCandidate: UsdaSearchResultItem = {
    fdcId: 8001,
    description: 'Cauliflower, cooked, roasted',
    dataType: 'Survey (FNDDS)',
    score: 200,
  };
  const friedCandidate: UsdaSearchResultItem = {
    fdcId: 8002,
    description: 'Fried cauliflower',
    dataType: 'Survey (FNDDS)',
    score: 210, // slight USDA relevance edge, but wrong preparation
  };

  it('prefers a roasted candidate over a fried candidate when the query says "roasted"', () => {
    const result = pickBestUsdaMatch([friedCandidate, roastedCandidate], {
      preparationHint: 'roasted',
    });
    expect(result!.candidate.fdcId).toBe(roastedCandidate.fdcId);
  });

  it('does not penalise a fried candidate when the query itself says "fried"', () => {
    const result = pickBestUsdaMatch([friedCandidate, roastedCandidate], {
      preparationHint: 'fried',
    });
    expect(result!.candidate.fdcId).toBe(friedCandidate.fdcId);
  });
});
