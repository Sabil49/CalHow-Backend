import { describe, expect, it } from 'vitest';
import { oilQuestionApplies, parseAiVisionResponse } from '../aiResponseSchema';
import { ApiRouteError } from '@/lib/apiResponse';

describe('parseAiVisionResponse', () => {
  it('maps a valid single-food response correctly', () => {
    const raw = {
      foods: [{ name: 'grilled chicken breast', preparation: 'grilled', portionGrams: 150, portionLabel: '1 fillet', confidence: 0.9 }],
      overallConfidence: 0.9,
    };
    const result = parseAiVisionResponse(raw, 'test-model');

    expect(result.detectedFoods).toHaveLength(1);
    expect(result.detectedFoods[0]).toMatchObject({
      rawName: 'grilled chicken breast',
      estimatedPortionGrams: 150,
      estimatedPortionLabel: '1 fillet',
      preparationMethod: 'grilled',
      detectionConfidence: 0.9,
    });
    expect(result.overallUncertainty).toBeCloseTo(0.1, 5);
    expect(result.modelVersion).toBe('test-model');
  });

  it('maps a multi-food response and preserves each food independently', () => {
    const raw = {
      foods: [
        { name: 'white rice', portionGrams: 200, confidence: 0.85 },
        { name: 'boiled egg', preparation: 'boiled', portionGrams: 50, confidence: 0.95 },
      ],
      overallConfidence: 0.9,
    };
    const result = parseAiVisionResponse(raw, 'test-model');
    expect(result.detectedFoods).toHaveLength(2);
    expect(result.detectedFoods[0].rawName).toBe('white rice');
    expect(result.detectedFoods[1].rawName).toBe('boiled egg');
  });

  it('aggregates per-food uncertaintyTopics into the meal-level suggestedClarificationTopics, de-duplicated', () => {
    const raw = {
      foods: [
        { name: 'fried rice', portionGrams: 200, confidence: 0.7, uncertaintyTopics: ['oil_amount'] },
        { name: 'stir-fried vegetables', portionGrams: 100, confidence: 0.7, uncertaintyTopics: ['oil_amount'] },
      ],
      overallConfidence: 0.7,
    };
    const result = parseAiVisionResponse(raw, 'test-model');
    expect(result.suggestedClarificationTopics).toEqual(['oil_amount']);
    expect(result.detectedFoods[0].uncertaintyTopics).toEqual(['oil_amount']);
  });

  it('accepts zero detected foods as structurally valid (the pipeline, not this schema, decides that is a failure)', () => {
    const raw = { foods: [], overallConfidence: 0.5 };
    const result = parseAiVisionResponse(raw, 'test-model');
    expect(result.detectedFoods).toEqual([]);
  });

  it('throws ApiRouteError("ai_provider_error") for a malformed response missing required fields', () => {
    const raw = { foods: [{ name: 'chicken' }] }; // missing portionGrams, confidence, overallConfidence
    expect(() => parseAiVisionResponse(raw, 'test-model')).toThrowError(ApiRouteError);
    try {
      parseAiVisionResponse(raw, 'test-model');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRouteError);
      expect((err as ApiRouteError).code).toBe('ai_provider_error');
    }
  });

  it('throws for invalid (negative/zero) portionGrams rather than accepting it', () => {
    const raw = { foods: [{ name: 'chicken', portionGrams: 0, confidence: 0.9 }], overallConfidence: 0.9 };
    expect(() => parseAiVisionResponse(raw, 'test-model')).toThrowError(ApiRouteError);
  });

  it('rejects an uncertaintyTopics value outside the known enum, rather than passing it through unchecked', () => {
    const raw = {
      foods: [{ name: 'chicken', portionGrams: 150, confidence: 0.9, uncertaintyTopics: ['made_up_topic'] }],
      overallConfidence: 0.9,
    };
    expect(() => parseAiVisionResponse(raw, 'test-model')).toThrowError(ApiRouteError);
  });

  it('throws for completely non-object input (e.g. a string, or undefined from a missing tool_use block)', () => {
    expect(() => parseAiVisionResponse('not json', 'test-model')).toThrowError(ApiRouteError);
    expect(() => parseAiVisionResponse(undefined, 'test-model')).toThrowError(ApiRouteError);
  });
});

describe('oil clarification and missing overall confidence', () => {
  it('drops the oil question for drinks, fruit and no-oil preparations, keeps it for pan-cooked food', () => {
    const result = parseAiVisionResponse(
      {
        foods: [
          { name: 'banana smoothie', preparation: 'blended', portionGrams: 350, confidence: 0.9, uncertaintyTopics: ['oil_amount'] },
          { name: 'mango shake', portionGrams: 300, confidence: 0.9, uncertaintyTopics: ['oil_amount'] },
          { name: 'steamed rice', preparation: 'steamed', portionGrams: 200, confidence: 0.9, uncertaintyTopics: ['oil_amount'] },
          { name: 'chicken curry', preparation: 'sauteed', portionGrams: 250, confidence: 0.8, uncertaintyTopics: ['oil_amount'] },
        ],
        overallConfidence: 0.85,
      },
      'test',
    );
    expect(result.detectedFoods.map((f) => f.uncertaintyTopics)).toEqual([undefined, undefined, undefined, ['oil_amount']]);
    expect(result.suggestedClarificationTopics).toEqual(['oil_amount']);
  });

  it('asks nothing about oil for a smoothie-only meal', () => {
    const result = parseAiVisionResponse(
      { foods: [{ name: 'banana smoothie', preparation: 'blended', portionGrams: 350, confidence: 0.9, uncertaintyTopics: ['oil_amount'] }], overallConfidence: 0.9 },
      'test',
    );
    expect(result.suggestedClarificationTopics).toBeUndefined();
  });

  it('falls back to the mean food confidence when overallConfidence is missing', () => {
    const result = parseAiVisionResponse(
      { foods: [{ name: 'rice', portionGrams: 200, confidence: 0.8 }, { name: 'dal', portionGrams: 150, confidence: 0.6 }] },
      'test',
    );
    expect(result.overallUncertainty).toBeCloseTo(0.3);
  });
});

describe('oilQuestionApplies', () => {
  it('keeps the oil question for fried dishes whose names sound like fruit or drinks', () => {
    expect(oilQuestionApplies({ name: 'banana fritters', preparation: 'fried' })).toBe(true);
    expect(oilQuestionApplies({ name: 'orange chicken', preparation: 'fried' })).toBe(true);
    expect(oilQuestionApplies({ name: 'apple fritter' })).toBe(true);
  });

  it('still drops it for drinks, fruit and no-oil preparations', () => {
    expect(oilQuestionApplies({ name: 'banana shake', preparation: 'blended' })).toBe(false);
    expect(oilQuestionApplies({ name: 'mango' })).toBe(false);
    expect(oilQuestionApplies({ name: 'steamed rice', preparation: 'steamed' })).toBe(false);
    expect(oilQuestionApplies({ name: 'chicken curry', preparation: 'sauteed' })).toBe(true);
  });
});
