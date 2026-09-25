import type { Request } from 'express';
import { z, type ZodType } from 'zod';
import { ApiRouteError } from './apiResponse';
import { getAppEnv } from './env';

/**
 * Request validation for all four meal endpoints, using Zod.
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
 * analysisId this photo was scanned under — the handler (see
 * meals/image.ts) verifies the caller owns this analysisId before
 * uploading, and uses it as the deterministic, user-scoped storage path
 * segment (see services/media/firebaseStorageImageProvider.ts):
 * meals/{uid}/{analysisId}.
 */
export const uploadMealImageRequestSchema = analyzeMealRequestSchema.extend({
  analysisId: z.string().min(1, 'analysisId is required'),
});

/**
 * Validates a request's already-parsed JSON body against `schema`
 * (Cloud Functions v2's `onRequest` parses JSON bodies into `req.body`
 * before the handler runs, unlike Next.js's `req.json()`). Throws
 * ApiRouteError('invalid_request', ...) on a schema mismatch — callers
 * (handlers, wrapped by withAuth) don't need their own try/catch for
 * this.
 */
export function parseJsonBody<S extends ZodType>(req: Request, schema: S): z.infer<S> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ApiRouteError('invalid_request', `Invalid request body: ${message}`);
  }
  return result.data;
}

/**
 * Detects an image's real format directly from its magic bytes, ignoring
 * whatever `mimeType` the client claims. This exists because client-
 * reported mimeType (from expo-image-picker et al.) doesn't always match
 * the actual re-encoded output bytes — e.g. a picker library can report
 * a photo's ORIGINAL format while quietly re-encoding it to a different
 * one during compression. That mismatch made Anthropic's vision API
 * reject the request outright: "the image was specified using the
 * image/png media type, but the image appears to be a image/jpeg
 * image." Bytes are authoritative; client-supplied metadata is not — so
 * every caller of this should prefer this detected type over
 * `body.mimeType` wherever the actual image bytes matter (the AI vision
 * call, the Storage upload), falling back to the client's claim only when
 * sniffing is inconclusive.
 */
export function detectImageMimeType(imageBase64: string): 'image/jpeg' | 'image/png' | null {
  let header: Buffer;
  try {
    // 16 base64 chars decode to 12 bytes — enough for both signatures below.
    header = Buffer.from(imageBase64.slice(0, 16), 'base64');
  } catch {
    return null;
  }

  if (header.length >= 8 && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    return 'image/png';
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
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
