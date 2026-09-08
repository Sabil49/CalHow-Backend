import type { NextRequest } from 'next/server';
import { z, type ZodType } from 'zod';
import { ApiRouteError } from './apiResponse';
import { getAppEnv } from './env';

/**
 * Request validation for all three endpoints, using Zod.
 *
 * Schemas here intentionally do NOT read env vars at module load time
 * (e.g. no `getAppEnv()` call inside a `.refine`) — that would defeat the
 * lazy-env-validation design in lib/env.ts, since these schemas are
 * module-level consts evaluated at import time. Image size limits are
 * checked separately, at request time, via `assertImageWithinSizeLimit`.
 */

const foodItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  portionLabel: z.string().min(1),
  portionGrams: z.number().nonnegative().optional(),
  calories: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
  imageUrl: z.string().optional(),
});

const clarificationAnswerSchema = z.object({
  questionId: z.string().min(1),
  optionId: z.string().min(1),
});

export const analyzeMealRequestSchema = z.object({
  imageBase64: z.string().min(1, 'imageBase64 is required'),
  mimeType: z.enum(['image/jpeg', 'image/png']),
});

export const clarifyMealRequestSchema = z.object({
  analysisId: z.string().min(1, 'analysisId is required'),
  answers: z.array(clarificationAnswerSchema).min(1, 'At least one answer is required'),
});

export const recalculateMealRequestSchema = z.object({
  analysisId: z.string().min(1, 'analysisId is required'),
  foods: z.array(foodItemSchema).min(1, 'At least one food item is required'),
});

/**
 * Same image/mimeType shape as analyzeMealRequestSchema, plus the
 * analysisId this photo was scanned under — the route (see
 * app/api/meals/image/route.ts) verifies the caller owns this analysisId
 * before uploading, and uses it as the deterministic, user-scoped storage
 * path segment (see services/media/cloudinaryImageStorageProvider.ts):
 * calhow/users/{uid}/meals/{analysisId}.
 */
export const uploadMealImageRequestSchema = analyzeMealRequestSchema.extend({
  analysisId: z.string().min(1, 'analysisId is required'),
});

/**
 * Reads and validates a request's JSON body against `schema`. Throws
 * ApiRouteError('invalid_request', ...) on malformed JSON or a schema
 * mismatch — callers (route handlers, wrapped by withAuth) don't need
 * their own try/catch for this.
 */
export async function parseJsonBody<S extends ZodType>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiRouteError('invalid_request', 'Request body must be valid JSON.');
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ApiRouteError('invalid_request', `Invalid request body: ${message}`);
  }
  return result.data;
}

/**
 * Rough decoded-byte-size check for a base64 image payload, checked
 * against MAX_IMAGE_BYTES (see lib/env.ts). Base64 encodes 3 bytes as 4
 * characters, so decoded size is ~ (length * 3/4), adjusted for padding.
 */
export function assertImageWithinSizeLimit(imageBase64: string): void {
  const { MAX_IMAGE_BYTES } = getAppEnv();
  const padding = imageBase64.endsWith('==') ? 2 : imageBase64.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor((imageBase64.length * 3) / 4) - padding;

  if (estimatedBytes > MAX_IMAGE_BYTES) {
    const maxMb = (MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(1);
    throw new ApiRouteError('payload_too_large', `Image is too large. Please use a photo under ${maxMb}MB.`);
  }
}
