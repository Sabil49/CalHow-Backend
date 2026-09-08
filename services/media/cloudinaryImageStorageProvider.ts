import { ApiRouteError } from '@/lib/apiResponse';
import { getCloudinaryEnv } from '@/lib/env';
import type { ImageStorageProvider, UploadImageParams, UploadImageResult } from './imageStorage';

/**
 * Cloudinary-backed implementation of ImageStorageProvider. Uses raw
 * `fetch` against Cloudinary's REST upload API (same "no extra SDK"
 * approach as services/nutrition/usda/usdaClient.ts) rather than adding
 * the `cloudinary` npm package for what is a single endpoint call.
 *
 * Auth: Cloudinary's upload endpoint accepts plain HTTP Basic Auth
 * (`api_key:api_secret`) as an alternative to computing an HMAC-SHA1
 * signature by hand — documented Cloudinary behavior, not a workaround.
 * `CLOUDINARY_API_SECRET` never leaves this server-side module.
 *
 * User-scoping / ownership: `public_id` is built from the CALLER'S VERIFIED
 * uid (never client-supplied — see UploadImageParams's doc comment) and
 * `imageId` (the caller's analysisId, ownership-checked before this is
 * ever called — see app/api/meals/image/route.ts), as
 * `calhow/users/{uid}/meals/{imageId}`. That means:
 *   - one user's image can only ever be written under their own uid path,
 *     so no upload can ever land under, or overwrite, another user's path
 *   - `overwrite: true` is intentional here (not a gap): the path is fully
 *     deterministic per user+analysis, so a retried upload for the SAME
 *     analysisId (e.g. the user taps Save again after a dropped
 *     connection) must succeed idempotently rather than fail with a
 *     spurious "already exists" — safe specifically because the path is
 *     already both user- and ownership-scoped, so "overwrite" only ever
 *     means "this same user replacing their own in-progress upload",
 *     never another user's or another analysis's image
 */
function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function createCloudinaryImageStorageProvider(): ImageStorageProvider {
  return {
    async upload({ imageBase64, mimeType, uid, imageId }: UploadImageParams): Promise<UploadImageResult> {
      const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = getCloudinaryEnv();

      const publicId = `calhow/users/${sanitizePathSegment(uid)}/meals/${sanitizePathSegment(imageId)}`;

      const form = new FormData();
      form.set('file', `data:${mimeType};base64,${imageBase64}`);
      form.set('public_id', publicId);
      form.set('overwrite', 'true');
      form.set('unique_filename', 'false');

      const basicAuth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');

      let response: Response;
      try {
        response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
          method: 'POST',
          headers: { Authorization: `Basic ${basicAuth}` },
          body: form,
        });
      } catch (err) {
        throw new ApiRouteError(
          'image_upload_error',
          `Could not reach the image storage service: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new ApiRouteError('image_upload_error', `Image upload failed with status ${response.status}. ${bodyText.slice(0, 200)}`);
      }

      let data: { secure_url?: string; public_id?: string };
      try {
        data = (await response.json()) as { secure_url?: string; public_id?: string };
      } catch {
        throw new ApiRouteError('image_upload_error', 'Image storage service returned a malformed response.');
      }

      if (!data.secure_url) {
        throw new ApiRouteError('image_upload_error', 'Image storage service did not return a URL.');
      }

      return { url: data.secure_url, providerId: data.public_id ?? publicId };
    },
  };
}
