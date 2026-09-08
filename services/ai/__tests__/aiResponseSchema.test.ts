import { describe, expect, it } from 'vitest';
import { parseAiVisionResponse } from '../aiResponseSchema';
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
