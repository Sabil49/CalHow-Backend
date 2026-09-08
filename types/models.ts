/**
 * Domain model types shared with the CalHow Expo app.
 *
 * KEPT IN SYNC MANUALLY with calhow/types/models.ts — this is a separate
 * repo from the mobile app (per project decision, no monorepo/private npm
 * package for V1), so these are hand-copied, not imported. If you change
 * FoodItem, ClarificationQuestion, ClarificationAnswer, or AiMealPrediction
 * here, make the same change in the mobile repo's types/models.ts, and
 * vice versa. Only the subset the backend actually touches is copied here
 * — not the full mobile UserProfile/Meal/WeightLog shapes.
 */

export interface FoodItem {
  id: string;
  name: string;
  /** Human-readable portion, e.g. "1/2 cup (90 g)". */
  portionLabel: string;
  portionGrams?: number;
  calories: number;
  /** 0-1. Optional because a user-added/edited food item may not have one. */
  confidence?: number;
  imageUrl?: string;
}

export interface ClarificationQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  helperText?: string;
  options: ClarificationQuestionOption[];
}

export interface ClarificationAnswer {
  questionId: string;
  optionId: string;
}

/**
 * The full AI-pipeline output for one meal photo. This is what the mobile
 * app stores verbatim as `Meal.aiPrediction` and never mutates — see the
 * doc comment on `Meal` in the mobile repo's types/models.ts for why.
 */
export interface AiMealPrediction {
  foods: FoodItem[];
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  fiber?: number;
  /** 0-1 overall confidence in this prediction. */
  confidence: number;
  clarificationQuestions?: ClarificationQuestion[];
  modelVersion?: string;
  /** ISO timestamp. */
  analyzedAt: string;
}
