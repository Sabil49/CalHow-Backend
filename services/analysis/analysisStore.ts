import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminFirestore } from '@/lib/firebaseAdmin';
import { ApiRouteError } from '@/lib/apiResponse';
import { getAppEnv } from '@/lib/env';
import type {
  AiMealPrediction,
  ClarificationAnswer,
  ClarificationQuestion,
} from '@/types/models';
import type { AiVisionResult, FoodMatch, PendingAnalysisDoc } from '@/types/nutrition';

/**
 * Firestore-backed store for `pendingAnalyses/{analysisId}` — the durable
 * state that lets `clarify` and `recalculate` operate on an `analyze`
 * result from a separate request, potentially minutes later, without any
 * in-memory session (Next.js route handlers are stateless per-invocation).
 *
 * Two things every function here must do, per the approved architecture:
 *   1. Verify `uid` ownership explicitly — the Admin SDK bypasses
 *      Firestore Security Rules, so there is no other enforcement layer.
 *   2. Never store image data — only structured analysis state.
 *
 * TTL is enforced lazily (checked on read, no scheduled cleanup job)
 * since Cloud Functions/schedulers aren't available on the Spark plan.
 * Expired documents are deleted opportunistically when encountered.
 */

const COLLECTION = 'pendingAnalyses';

function collection() {
  return getAdminFirestore().collection(COLLECTION);
}

export interface CreatePendingAnalysisParams {
  uid: string;
  aiResult: AiVisionResult;
  foodMatches: FoodMatch[];
  prediction: AiMealPrediction;
  clarificationQuestions?: ClarificationQuestion[];
}

/** Creates a new pending analysis and returns its generated id + the stored document. */
export async function createPendingAnalysis(
  params: CreatePendingAnalysisParams,
): Promise<{ analysisId: string; doc: PendingAnalysisDoc }> {
  const { ANALYSIS_TTL_MINUTES } = getAppEnv();
  const ref = collection().doc();
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + ANALYSIS_TTL_MINUTES * 60_000);

  const doc: PendingAnalysisDoc = {
    analysisId: ref.id,
    uid: params.uid,
    status: params.clarificationQuestions?.length ? 'awaiting_clarification' : 'complete',
    aiResult: params.aiResult,
    foodMatches: params.foodMatches,
    prediction: params.prediction,
    clarificationQuestions: params.clarificationQuestions,
    createdAt: now,
    expiresAt,
  };

  await ref.set(doc);
  return { analysisId: ref.id, doc };
}

/**
 * Reads a pending analysis, enforcing ownership and expiry. Throws:
 *   - ApiRouteError('analysis_not_found') if the doc doesn't exist
 *   - ApiRouteError('forbidden') if it exists but belongs to another uid
 *   - ApiRouteError('analysis_expired') if past its TTL (and lazily deletes it)
 */
export async function getPendingAnalysisForUser(analysisId: string, uid: string): Promise<PendingAnalysisDoc> {
  const ref = collection().doc(analysisId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new ApiRouteError('analysis_not_found', 'This analysis could not be found. Please scan your meal again.');
  }

  const doc = snap.data() as PendingAnalysisDoc;

  if (doc.uid !== uid) {
    // Deliberately distinct from analysis_not_found per the approved API
    // contract — but note both ultimately guide the client to the same
    // "scan again" recovery path.
    throw new ApiRouteError('forbidden', 'This analysis does not belong to your account.');
  }

  if (doc.expiresAt.toMillis() < Date.now()) {
    await ref.delete().catch(() => {
      // Best-effort cleanup — an expired doc lingering briefly if this
      // delete fails is harmless; it'll be caught again on next read.
    });
    throw new ApiRouteError('analysis_expired', 'This analysis has expired. Please scan your meal again.');
  }

  return doc;
}

export interface UpdatePendingAnalysisPatch {
  status?: PendingAnalysisDoc['status'];
  prediction?: AiMealPrediction;
  foodMatches?: FoodMatch[];
  clarificationAnswers?: ClarificationAnswer[];
  clarificationQuestions?: ClarificationQuestion[] | FieldValue;
}

/** Updates a pending analysis after re-verifying ownership + expiry via getPendingAnalysisForUser. */
export async function updatePendingAnalysis(
  analysisId: string,
  uid: string,
  patch: UpdatePendingAnalysisPatch,
): Promise<PendingAnalysisDoc> {
  const existing = await getPendingAnalysisForUser(analysisId, uid);
  const ref = collection().doc(analysisId);
  await ref.update(patch as Record<string, unknown>);
  return { ...existing, ...patch } as PendingAnalysisDoc;
}
