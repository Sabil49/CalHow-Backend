import { createFirebaseStorageImageProvider } from './firebaseStorageImageProvider';

/**
 * Durable meal-photo storage — kept as an interface (not a Firebase-
 * Storage-specific export), same pattern as
 * NutritionLookupProvider/VisionProvider elsewhere in this codebase, so
 * the concrete provider is swappable without touching the code that calls
 * it. See services/media/firebaseStorageImageProvider.ts for the current
 * implementation.
 */

export interface UploadImageParams {
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png';
  /**
   * Firebase Auth uid that owns this image — always the verified uid from
   * `withAuth` (see lib/auth.ts), never anything read from a request body.
   * The provider must scope the storage path under this uid so one user's
   * upload can never collide with, or overwrite, another user's image.
   */
  uid: string;
  /**
   * Identifies WHICH image this is within the user's own namespace — the
   * analysisId the photo was scanned under today (see
   * meals/image.ts, which verifies the caller owns this analysisId via
   * getPendingAnalysisForUser before it ever reaches here), or a mealId
   * for a future "replace this meal's photo" flow. Combined with `uid`,
   * the provider builds a fully deterministic, user- and resource-scoped
   * path: `meals/{uid}/{imageId}`. Being deterministic (not a fresh random
   * id per call) makes a retry of the same upload idempotent — see
   * firebaseStorageImageProvider.ts's overwrite handling.
   */
  imageId: string;
}

export interface UploadImageResult {
  /** Durable HTTPS URL — safe to store as Meal.imageUrl. */
  url: string;
  /**
   * Provider-specific identifier for the stored asset (the Storage object
   * path, i.e. `meals/{uid}/{imageId}`) — not used by any caller yet, kept
   * for a future per-meal delete flow to request cleanup of the right
   * asset without parsing the URL. See the TODO in
   * calhow-mobile/services/mealImagePersistence.ts.
   */
  providerId: string;
}

export interface ImageStorageProvider {
  upload(params: UploadImageParams): Promise<UploadImageResult>;
}

export function getImageStorageProvider(): ImageStorageProvider {
  return createFirebaseStorageImageProvider();
}
