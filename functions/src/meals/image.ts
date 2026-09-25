import type { Request, Response } from 'express';
import { withAuth } from '@/lib/auth';
import { jsonSuccess } from '@/lib/apiResponse';
import { parseJsonBody, uploadMealImageRequestSchema, assertImageWithinSizeLimit, detectImageMimeType } from '@/lib/validation';
import { getPendingAnalysisForUser } from '@/services/analysis/analysisStore';
import { getImageStorageProvider } from '@/services/media/imageStorage';
import type { UploadMealImageResponse } from '@/types/api';

/**
 * POST /uploadMealImage
 *
 * Uploads a meal photo to durable, user-scoped remote storage (see
 * services/media/) and returns its URL. Deliberately a separate function
 * from analyzeMeal — analyze never persists the image (see that
 * handler's doc comment), so a slow/failed upload here can never block or
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
 * resulting path (meals/{uid}/{analysisId}, see
 * services/media/firebaseStorageImageProvider.ts) genuinely user-scoped
 * and overwrite-safe: a caller can only ever write under their own uid,
 * and only using an analysisId they actually own.
 */
export const uploadMealImageHandler = withAuth(async (req: Request, res: Response, { uid }) => {
  const body = await parseJsonBody(req, uploadMealImageRequestSchema);
  assertImageWithinSizeLimit(body.imageBase64);
  await getPendingAnalysisForUser(body.analysisId, uid);

  // Trust the actual image bytes over the client's claimed mimeType — see
  // lib/validation.ts's detectImageMimeType doc comment. Storing under
  // the wrong declared type would mislabel the Storage object.
  const mimeType = detectImageMimeType(body.imageBase64) ?? body.mimeType;

  const { url } = await getImageStorageProvider().upload({
    imageBase64: body.imageBase64,
    mimeType,
    uid,
    imageId: body.analysisId,
  });

  const response: UploadMealImageResponse = { imageUrl: url };
  jsonSuccess(res, response);
});
