import { z } from 'zod';
import { ApiRouteError } from '@/lib/apiResponse';
import type { AiDetectedFood, AiVisionResult } from '@/types/nutrition';

/**
 * Strict schema for what an AI vision provider is allowed to return.
 *
 * Deliberately close to the shape described in the project brief
 * (`{ foods: [{ name, preparation?, portionGrams, portionLabel?,
 * confidence, uncertaintyTopics? }], overallConfidence }`), reusing our
 * existing internal field names (`AiDetectedFood`/`AiVisionResult` in
 * types/nutrition.ts) at the mapping boundary below rather than
 * introducing a second, parallel vocabulary — per "make the smallest
 * clean change" rather than adopting the brief's exact shape verbatim.
 *
 * `uncertaintyTopics` is restricted to a known, small enum — NOT a free
 * string — so the AI can only flag uncertainty in ways our clarification
 * policy (services/analysis/clarification.ts) actually has a pre-authored
 * question for. This keeps V1 controlled and predictable, per the
 * clarification policy requirement: the AI can highlight uncertainty, but
 * it cannot invent a new question topic out of thin air.
 *
 * NOTHING here has a calories/protein/carbs/fat/fiber field — that's not
 * an oversight, it's the whole point: this schema makes it structurally
 * impossible for the AI's response to carry final nutrition numbers.
 */
const KNOWN_UNCERTAINTY_TOPICS = ['oil_amount'] as const;

export const aiFoodDetectionSchema = z.object({
  name: z.string().min(1),
  preparation: z.string().min(1).optional(),
  /** The AI's job includes estimating this — required, not optional, unlike the general-purpose AiDetectedFood.estimatedPortionGrams (which stays optional for other potential callers/providers). */
  portionGrams: z.number().positive(),
  portionLabel: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  uncertaintyTopics: z.array(z.enum(KNOWN_UNCERTAINTY_TOPICS)).optional(),
});

export const aiVisionResponseSchema = z.object({
  foods: z.array(aiFoodDetectionSchema),
  overallConfidence: z.number().min(0).max(1),
});

export type AiVisionResponsePayload = z.infer<typeof aiVisionResponseSchema>;

/**
 * Validates `raw` (whatever JSON-like value the provider extracted from
 * the model's response) against the schema above, then maps it into our
 * internal AiVisionResult. Throws `ApiRouteError('ai_provider_error', ...)`
 * — not a raw ZodError — on any mismatch, since a provider returning
 * something that doesn't fit this schema is exactly the "malformed AI
 * response" failure case the project's failure policy requires a
 * structured error for, not a fabricated/best-effort result.
 */
export function parseAiVisionResponse(raw: unknown, modelVersion: string): AiVisionResult {
  const result = aiVisionResponseSchema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ApiRouteError('ai_provider_error', `AI response did not match the expected structure: ${message}`);
  }

  const detectedFoods: AiDetectedFood[] = result.data.foods.map((food) => ({
    rawName: food.name,
    estimatedPortionGrams: food.portionGrams,
    estimatedPortionLabel: food.portionLabel,
    preparationMethod: food.preparation,
    detectionConfidence: food.confidence,
    uncertaintyTopics: food.uncertaintyTopics,
  }));

  // Aggregated for AiVisionResult.suggestedClarificationTopics (meal-wide
  // signal already consumed by evaluateClarificationPolicy) — the AI
  // reports uncertainty per food; this just de-duplicates it up to the
  // meal level rather than asking the model to report the same thing twice.
  const suggestedClarificationTopics = Array.from(new Set(result.data.foods.flatMap((food) => food.uncertaintyTopics ?? [])));

  return {
    detectedFoods,
    overallUncertainty: 1 - result.data.overallConfidence,
    suggestedClarificationTopics: suggestedClarificationTopics.length > 0 ? suggestedClarificationTopics : undefined,
    modelVersion,
  };
}
