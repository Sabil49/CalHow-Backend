import { randomUUID } from 'node:crypto';
import { getAdminStorage } from '@/lib/firebaseAdmin';
import { ApiRouteError } from '@/lib/apiResponse';
import type { ImageStorageProvider, UploadImageParams, UploadImageResult } from './imageStorage';

/**
 * Firebase Storage-backed implementation of ImageStorageProvider, using
 * the Admin SDK against the project's default bucket (Admin SDK access
 * bypasses storage.rules entirely, same trust model as Firestore — see
 * lib/firebaseAdmin.ts).
 *
 * URL scheme: a Storage download-token URL (the same
 * `https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}?alt=media&token={token}`
 * format the client SDK's `getDownloadURL()` produces), not a public
 * bucket URL. This means storage.rules can stay default-deny — the token
 * itself, not a rules grant, is what makes the URL work — while
 * `Meal.imageUrl` is still a plain HTTPS URL any `<Image>` can load
 * directly, no auth header required.
 *
 * User-scoping / ownership: the object path is built from the CALLER'S
 * VERIFIED uid (never client-supplied — see UploadImageParams's doc
 * comment) and `imageId` (the caller's analysisId, ownership-checked
 * before this is ever called — see meals/image.ts), as
 * `meals/{uid}/{imageId}`. That means:
 *   - one user's image can only ever be written under their own uid path,
 *     so no upload can ever land under, or overwrite, another user's path
 *   - the path is fully deterministic per user+analysis, so a retried
 *     upload for the SAME analysisId (e.g. the user taps Save again after
 *     a dropped connection) overwrites the same object and succeeds
 *     idempotently rather than failing with a spurious "already exists"
 */
function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function createFirebaseStorageImageProvider(): ImageStorageProvider {
  return {
    async upload({ imageBase64, mimeType, uid, imageId }: UploadImageParams): Promise<UploadImageResult> {
      const objectPath = `meals/${sanitizePathSegment(uid)}/${sanitizePathSegment(imageId)}`;
      const downloadToken = randomUUID();

      let bucketName: string;
      try {
        const file = getAdminStorage().bucket().file(objectPath);
        bucketName = file.bucket.name;
        await file.save(Buffer.from(imageBase64, 'base64'), {
          contentType: mimeType,
          metadata: { metadata: { firebaseStorageDownloadTokens: downloadToken } },
        });
      } catch (err) {
        throw new ApiRouteError(
          'image_upload_error',
          `Could not upload image to storage: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const url = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${downloadToken}`;
      return { url, providerId: objectPath };
    },
  };
}
