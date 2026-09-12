import type { NextRequest } from 'next/server';
import { withAuth } from '@/lib/auth';
import { jsonSuccess } from '@/lib/apiResponse';
import { parseJsonBody, uploadMealImageRequestSchema, assertImageWithinSizeLimit, detectImageMimeType } from '@/lib/validation';
import { getPendingAnalysisForUser } from '@/services/analysis/analysisStore';
import { getImageStorageProvider } from '@/services/media/imageStorage';
import type { UploadMealImageResponse } from '@/types/api';

/** See app/api/meals/analyze/route.ts's doc comment on maxDuration — same reasoning (a large photo upload to Cloudinary can be slow). */
export const maxDuration = 60;

/**
 * POST /api/meals/image
 *
 * Uploads a meal photo to durable, user-scoped remote storage (see
 * services/media/) and returns its URL. Deliberately a separate endpoint
 * from /api/meals/analyze — analyze never persists the image (see that
 * route's doc comment), so a slow/failed upload here can never block or
 * corrupt AI analysis. The mobile app calls this once, when the user
 * actually saves the meal (see
 * calhow-mobile/services/mealImagePersistence.ts), reusing the same
 * imageBase64/mimeType already held in scan session state from capture —
 * no re-read of the device file is needed.
 *
 * `uid` is the verified uid from `withAuth`, never anything from the
 * request body. `body.analysisId` IS client-supplied, so — same pattern as
 * clarify/recalculate — its ownership is verified via
 * getPendingAnalysisForUser before it's trusted for anything, including
 * use as the storage path segment. Together these are what make the
 * resulting path (calhow/users/{uid}/meals/{analysisId}, see
 * services/media/cloudinaryImageStorageProvider.ts) genuinely user-scoped
 * and overwrite-safe: a caller can only ever write under their own uid,
 * and only using an analysisId they actually own.
 */
export const POST = withAuth(async (req: NextRequest, { uid }) => {
  const body = await parseJsonBody(req, uploadMealImageRequestSchema);
  assertImageWithinSizeLimit(body.imageBase64);
  await getPendingAnalysisForUser(body.analysisId, uid);

  // Trust the actual image bytes over the client's claimed mimeType — see
  // lib/validation.ts's detectImageMimeType doc comment. Storing under
  // the wrong declared type would mislabel the Cloudinary data URI.
  const mimeType = detectImageMimeType(body.imageBase64) ?? body.mimeType;

  const { url } = await getImageStorageProvider().upload({
    imageBase64: body.imageBase64,
    mimeType,
    uid,
    imageId: body.analysisId,
  });

  const response: UploadMealImageResponse = { imageUrl: url };
  return jsonSuccess(response);
});
