import type { Timestamp } from 'firebase-admin/firestore';
import type { AiMealPrediction, ClarificationAnswer, ClarificationQuestion, FoodItem } from './models';

/**
 * Types for the internal pipeline stages described in the architecture:
 *   Image -> AI (identification/portion/prep/uncertainty) -> normalization
 *   -> USDA matching -> per-100g nutrition -> deterministic calculation
 *   -> confidence/clarification
 *
 * These never cross the wire to the mobile app (that's types/api.ts) —
 * they exist to give each pipeline stage a clear, typed boundary.
 */

// ---------------------------------------------------------------------------
// Stage 1: AI vision output (raw, un-normalized, NOT final nutrition)
// ---------------------------------------------------------------------------

/**
 * One food item as the AI vision model reports it — a raw name, an
 * estimated portion, and its own confidence. Deliberately has NO calorie
 * or macro fields: the AI's job stops at identification/estimation, per
 * the project's core nutrition rule that AI never invents final numbers.
 */
export interface AiDetectedFood {
  /** Exactly what the model said, e.g. "grilled chicken breast", unnormalized. */
  rawName: string;
  estimatedPortionGrams?: number;
  /** Human-friendly portion the model inferred, e.g. "1 medium fillet". */
  estimatedPortionLabel?: string;
  /** e.g. "grilled", "fried", "steamed" — feeds both matching and clarification. */
  preparationMethod?: string;
  /** 0-1. The AI's confidence this food is present and correctly identified. */
  detectionConfidence: number;
  /** Per-food uncertainty hints, e.g. ["oil_amount"] if cooking oil/sauce amount is visually ambiguous for THIS food specifically. Restricted to a small known set at the provider boundary (see services/ai/providers/) — an unrecognized topic is simply ignored by the clarification policy, never fabricated into a question. */
  uncertaintyTopics?: string[];
}

/**
 * The full, raw output of the AI vision stage for one photo. This is the
 * ONLY thing services/ai/visionProvider.ts is responsible for producing.
 */
export interface AiVisionResult {
  detectedFoods: AiDetectedFood[];
  /** 0-1. The AI's own self-reported uncertainty about the analysis as a whole. */
  overallUncertainty: number;
  /** Free-form hints from the AI about what it's unsure of, e.g. ["oil_amount", "portion_size"] — input to the clarification policy, not a fixed enum, since the AI provider isn't chosen yet. */
  suggestedClarificationTopics?: string[];
  modelVersion: string;
}

// ---------------------------------------------------------------------------
// Stage 2/3: Normalization + USDA matching
// ---------------------------------------------------------------------------

/**
 * Per-100g nutrition facts from a structured nutrition database (USDA
 * FoodData Central for V1). This — not the AI — is the source of truth
 * for nutrition numbers.
 */
export interface NutritionFactsPer100g {
  source: 'usda_fdc';
  /** USDA FDC ID for the matched food. */
  sourceId: string;
  /** USDA's canonical description for the matched entry, kept for auditability/debugging. */
  description: string;
  /** USDA's dataType for the matched entry (e.g. "Foundation", "SR Legacy", "Survey (FNDDS)", "Branded") — kept for auditability; the matcher deprioritizes Branded by default. */
  dataType?: string;
  /** 0-1, normalized confidence the matcher assigned this specific candidate — surfaced here so FoodMatcher (services/foodMatching/foodMatcher.ts) doesn't need to know USDA internals to compute FoodMatch.matchConfidence. */
  matchScore?: number;
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatsPer100g: number;
  fiberPer100g?: number;
}

/**
 * Common shape both AI-detected foods (AiDetectedFood) and user-edited
 * mobile FoodItems can be adapted to for normalization — see
 * services/foodMatching/normalizer.ts. Kept separate from AiDetectedFood
 * so the normalizer has one real implementation shared by both the
 * `analyze` and `recalculate` flows, rather than two copies.
 */
export interface NormalizerInput {
  rawName: string;
  estimatedPortionGrams?: number;
  estimatedPortionLabel?: string;
  preparationMethod?: string;
}

/**
 * The result of matching one AI-detected food to a structured nutrition
 * database entry. `nutrition` is null when no sufficiently confident match
 * was found — callers must handle that (e.g. by lowering overall
 * confidence and/or raising a clarification question), never by guessing.
 */
export interface FoodMatch {
  /** The AiDetectedFood.rawName this match is for. */
  detectedName: string;
  /** Cleaned-up/canonicalized name used for the DB lookup, e.g. "chicken breast, grilled, skinless". */
  normalizedName: string;
  portionGrams: number;
  nutrition: NutritionFactsPer100g | null;
  /** 0-1. Confidence in the normalization+matching step itself — distinct from the AI's own detectionConfidence. */
  matchConfidence: number;
}

// ---------------------------------------------------------------------------
// Pending analysis (Firestore: pendingAnalyses/{analysisId})
// ---------------------------------------------------------------------------

export type PendingAnalysisStatus = 'awaiting_clarification' | 'complete';

/**
 * Structured, durable state for one in-progress analysis, keyed by
 * analysisId. Deliberately holds NO image data (see
 * services/mealImagePersistence.ts equivalent decision on the mobile
 * side — the backend doesn't retain images either). `clarify` and
 * `recalculate` operate entirely on this structured state.
 */
export interface PendingAnalysisDoc {
  analysisId: string;
  /** Firebase Auth uid that created this analysis. Every read/update MUST verify this matches the authenticated caller — Admin SDK bypasses Firestore rules, so this check has to happen in code. */
  uid: string;
  status: PendingAnalysisStatus;
  /** Raw AI output, kept for clarification re-evaluation without re-calling the vision model. */
  aiResult: AiVisionResult;
  /** Matched nutrition per detected food, kept so recalculate can redo the deterministic math without re-querying USDA. */
  foodMatches: FoodMatch[];
  /** The current best-known prediction, recomputed deterministically (see services/nutrition/calculate.ts) — this is what analyze/clarify return to the client. */
  prediction: AiMealPrediction;
  clarificationQuestions?: ClarificationQuestion[];
  clarificationAnswers?: ClarificationAnswer[];
  createdAt: Timestamp;
  /** createdAt + ANALYSIS_TTL_MINUTES. Checked lazily on read (see services/analysis/analysisStore.ts) — no scheduled cleanup job, since Cloud Functions/schedulers aren't available on the Spark plan. */
  expiresAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Deterministic calculation
// ---------------------------------------------------------------------------

/** Output of services/nutrition/calculate.ts — pure math, no AI/DB calls. */
export interface MealTotals {
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  fiber?: number;
}

export type { FoodItem };
