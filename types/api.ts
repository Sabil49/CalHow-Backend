/**
 * API contract types shared with the CalHow Expo app.
 *
 * KEPT IN SYNC MANUALLY with calhow/types/api.ts — see the note in
 * types/models.ts. These shapes are the actual wire contract; the mobile
 * app's services/api.ts already implements the client side of this
 * exactly, so changing anything here requires a corresponding mobile
 * change (or you'll break the app).
 */
import type { AiMealPrediction, ClarificationAnswer, ClarificationQuestion, FoodItem } from './models';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** POST /api/meals/analyze */
export interface AnalyzeMealRequest {
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface AnalyzeMealResponse {
  analysisId: string;
  prediction: AiMealPrediction;
  needsClarification: boolean;
  clarificationQuestions?: ClarificationQuestion[];
  /**
   * Backend-authoritative free-tier scan quota status, as of this call —
   * see services/usage/scanLimit.ts. Optional/additive so older mobile
   * builds that don't read it keep working unchanged. `null` count/limit
   * fields mean unlimited (a 'pro' entitlement).
   */
  quota?: {
    entitlement: 'free' | 'pro';
    scansUsedToday: number | null;
    scansRemainingToday: number | null;
    dailyScanLimit: number | null;
  };
}

/** POST /api/meals/clarify */
export interface ClarifyMealRequest {
  analysisId: string;
  answers: ClarificationAnswer[];
}

export interface ClarifyMealResponse {
  prediction: AiMealPrediction;
}

/** POST /api/meals/recalculate — user edited detected foods, get fresh totals. */
export interface RecalculateMealRequest {
  analysisId: string;
  foods: FoodItem[];
}

export interface RecalculateMealResponse {
  /** Per-food items with calories and portionLabel derived from the USDA match. sum(foods[].calories) === calories (to integer rounding). */
  foods: FoodItem[];
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  fiber?: number;
}

/**
 * POST /api/meals/image — uploads a meal photo to durable, user-scoped
 * remote storage and returns its URL. Same image/mimeType shape as
 * AnalyzeMealRequest, plus `analysisId` (see
 * lib/validation.ts's uploadMealImageRequestSchema) — the route verifies
 * the caller owns this analysisId (same check clarify/recalculate already
 * do) and uses it as the deterministic storage path segment:
 * calhow/users/{uid}/meals/{analysisId}. A separate endpoint from analyze:
 * analyze never persists the image, so a slow/failed upload can never
 * block or corrupt AI analysis, and the mobile app calls this
 * independently once the user actually saves the meal (see
 * calhow-mobile/services/mealImagePersistence.ts).
 */
export interface UploadMealImageRequest {
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png';
  analysisId: string;
}

export interface UploadMealImageResponse {
  /** Durable HTTPS URL — safe to store as Meal.imageUrl. Never a local/temporary URI. */
  imageUrl: string;
}
