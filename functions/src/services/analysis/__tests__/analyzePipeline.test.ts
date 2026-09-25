import { describe, expect, it, vi } from 'vitest';
import { runAnalyzePipeline } from '../analyzePipeline';
import { ApiRouteError } from '@/lib/apiResponse';
import type { VisionProvider } from '@/services/ai/visionProvider';
import type { NutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import type { AiVisionResult, NutritionFactsPer100g } from '@/types/nutrition';

function fakeVision(result: AiVisionResult): VisionProvider {
  return { analyzeMealImage: vi.fn().mockResolvedValue(result) };
}

function fakeVisionRejecting(error: unknown): VisionProvider {
  return { analyzeMealImage: vi.fn().mockRejectedValue(error) };
}

function nutrition(overrides: Partial<NutritionFactsPer100g>): NutritionFactsPer100g {
  return {
    source: 'usda_fdc',
    sourceId: '1',
    description: 'test food',
    caloriesPer100g: 0,
    proteinPer100g: 0,
    carbsPer100g: 0,
    fatsPer100g: 0,
    matchScore: 0.9,
    ...overrides,
  };
}

const chickenNutrition = nutrition({ caloriesPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatsPer100g: 3.6, fiberPer100g: 0 });
const riceNutrition = nutrition({ caloriesPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28.2, fatsPer100g: 0.3, fiberPer100g: 0.4 });

/** Looks up nutrition by checking which known substring the (normalized) query contains — good enough for these fixed test fixtures. */
function fakeLookupByName(entries: Record<string, NutritionFactsPer100g | null>): NutritionLookupProvider {
  return {
    lookup: vi.fn().mockImplementation(async (normalizedName: string) => {
      const match = Object.keys(entries).find((key) => normalizedName.includes(key));
      return match ? entries[match] : null;
    }),
  };
}

describe('runAnalyzePipeline', () => {
  it('one-food meal: builds a correct prediction with no clarification needed', async () => {
    const aiResult: AiVisionResult = {
      detectedFoods: [{ rawName: 'grilled chicken breast', estimatedPortionGrams: 150, preparationMethod: 'grilled', detectionConfidence: 0.92 }],
      overallUncertainty: 0.08,
      modelVersion: 'test-model',
    };
    const deps = { visionProvider: fakeVision(aiResult), lookupProvider: fakeLookupByName({ chicken: chickenNutrition }) };

    const result = await runAnalyzePipeline({ imageBase64: 'x', mimeType: 'image/jpeg' }, deps);

    expect(result.prediction.foods).toHaveLength(1);
    expect(result.prediction.calories).toBe(Math.round(165 * 1.5));
    expect(result.clarificationQuestions).toHaveLength(0);
    expect(result.prediction.clarificationQuestions).toBeUndefined();
  });

  it('multiple-food meal: sums totals across all detected foods', async () => {
    const aiResult: AiVisionResult = {
      detectedFoods: [
        { rawName: 'grilled chicken breast', estimatedPortionGrams: 150, detectionConfidence: 0.9 },
        { rawName: 'cooked white rice', estimatedPortionGrams: 200, detectionConfidence: 0.85 },
      ],
      overallUncertainty: 0.1,
      modelVersion: 'test-model',
    };
    const deps = {
      visionProvider: fakeVision(aiResult),
      lookupProvider: fakeLookupByName({ chicken: chickenNutrition, rice: riceNutrition }),
    };

    const result = await runAnalyzePipeline({ imageBase64: 'x', mimeType: 'image/jpeg' }, deps);

    expect(result.prediction.foods).toHaveLength(2);
    const expectedCalories = Math.round(165 * 1.5) + Math.round(130 * 2);
    expect(result.prediction.calories).toBe(expectedCalories);
  });

  it('low-confidence / oil-uncertain meal: generates the oil_amount clarification question', async () => {
    const aiResult: AiVisionResult = {
      detectedFoods: [
        { rawName: 'fried rice', estimatedPortionGrams: 200, detectionConfidence: 0.6, uncertaintyTopics: ['oil_amount'] },
      ],
      overallUncertainty: 0.4,
      suggestedClarificationTopics: ['oil_amount'],
      modelVersion: 'test-model',
    };
    const deps = { visionProvider: fakeVision(aiResult), lookupProvider: fakeLookupByName({ rice: riceNutrition }) };

    const result = await runAnalyzePipeline({ imageBase64: 'x', mimeType: 'image/jpeg' }, deps);

    expect(result.clarificationQuestions).toHaveLength(1);
    expect(result.clarificationQuestions[0].id).toBe('oil_amount');
    expect(result.prediction.clarificationQuestions).toHaveLength(1);
  });

  it('malformed AI response: propagates the provider\u2019s error rather than fabricating a result', async () => {
    const providerError = new ApiRouteError('ai_provider_error', 'AI response did not match the expected structure.');
    const deps = { visionProvider: fakeVisionRejecting(providerError), lookupProvider: fakeLookupByName({}) };

    await expect(runAnalyzePipeline({ imageBase64: 'x', mimeType: 'image/jpeg' }, deps)).rejects.toBe(providerError);
  });

  it('zero detected foods: fails with invalid_request instead of returning an empty/fabricated meal', async () => {
    const aiResult: AiVisionResult = { detectedFoods: [], overallUncertainty: 0, modelVersion: 'test-model' };
    const deps = { visionProvider: fakeVision(aiResult), lookupProvider: fakeLookupByName({}) };

    try {
      await runAnalyzePipeline({ imageBase64: 'x', mimeType: 'image/jpeg' }, deps);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRouteError);
      expect((err as ApiRouteError).code).toBe('invalid_request');
    }
  });

  it('USDA lookup failure: fails the WHOLE request naming the unmatched food, never under-totals silently', async () => {
    const aiResult: AiVisionResult = {
      detectedFoods: [
        { rawName: 'grilled chicken breast', estimatedPortionGrams: 150, detectionConfidence: 0.9 },
        { rawName: 'some unrecognizable mystery dish', estimatedPortionGrams: 100, detectionConfidence: 0.5 },
      ],
      overallUncertainty: 0.2,
      modelVersion: 'test-model',
    };
    // Only "chicken" resolves; the mystery dish has no USDA match (null).
    const deps = { visionProvider: fakeVision(aiResult), lookupProvider: fakeLookupByName({ chicken: chickenNutrition }) };

    try {
      await runAnalyzePipeline({ imageBase64: 'x', mimeType: 'image/jpeg' }, deps);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRouteError);
      expect((err as ApiRouteError).code).toBe('nutrition_lookup_error');
      expect((err as Error).message).toContain('mystery dish');
    }
  });

  it('invalid portion grams: fails with invalid_request when a food has no determinable gram amount', async () => {
    const aiResult: AiVisionResult = {
      detectedFoods: [{ rawName: 'some food', estimatedPortionGrams: undefined, estimatedPortionLabel: undefined, detectionConfidence: 0.8 }],
      overallUncertainty: 0.2,
      modelVersion: 'test-model',
    };
    const deps = { visionProvider: fakeVision(aiResult), lookupProvider: fakeLookupByName({ food: chickenNutrition }) };

    try {
      await runAnalyzePipeline({ imageBase64: 'x', mimeType: 'image/jpeg' }, deps);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRouteError);
      expect((err as ApiRouteError).code).toBe('invalid_request');
    }
  });

  it('final nutrition totals come from USDA per-100g data, not any AI-provided number', async () => {
    // Two otherwise-identical detections that differ ONLY in AI confidence
    // and uncertainty — neither of which should affect the calorie math.
    const buildAiResult = (detectionConfidence: number): AiVisionResult => ({
      detectedFoods: [{ rawName: 'grilled chicken breast', estimatedPortionGrams: 150, detectionConfidence }],
      overallUncertainty: 1 - detectionConfidence,
      modelVersion: 'test-model',
    });
    const lookupProvider = fakeLookupByName({ chicken: chickenNutrition });

    const low = await runAnalyzePipeline({ imageBase64: 'x', mimeType: 'image/jpeg' }, { visionProvider: fakeVision(buildAiResult(0.3)), lookupProvider });
    const high = await runAnalyzePipeline({ imageBase64: 'x', mimeType: 'image/jpeg' }, { visionProvider: fakeVision(buildAiResult(0.99)), lookupProvider });

    // Calories are identical regardless of the AI's stated confidence —
    // proving they came from USDA's per-100g figure scaled by grams, not
    // from anything the AI reported.
    expect(low.prediction.calories).toBe(high.prediction.calories);
    expect(low.prediction.calories).toBe(Math.round(chickenNutrition.caloriesPer100g * 1.5));
    // The overall PREDICTION confidence, unlike calories, legitimately
    // does differ with detection confidence — sanity-checking the test
    // setup actually varied something meaningful.
    expect(low.prediction.confidence).toBeLessThan(high.prediction.confidence);
  });
});
