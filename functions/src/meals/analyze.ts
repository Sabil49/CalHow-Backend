import type { Request, Response } from 'express';
import { withAuth } from '@/lib/auth';
import { ApiRouteError, jsonSuccess } from '@/lib/apiResponse';
import { analyzeMealRequestSchema, assertImageWithinSizeLimit, detectImageMimeType, parseJsonBody } from '@/lib/validation';
import { consumeScanIfAllowed, refundScan } from '@/services/usage/scanLimit';
import { getVisionProvider } from '@/services/ai/visionProvider';
import { getNutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import { runAnalyzePipeline } from '@/services/analysis/analyzePipeline';
import { createPendingAnalysis } from '@/services/analysis/analysisStore';
import type { AnalyzeMealResponse } from '@/types/api';

/** Failures that are our fault, not the user's — the consumed scan is refunded (see refundScan). */
const REFUNDABLE_ERROR_CODES = new Set<string>(['ai_provider_error', 'nutrition_lookup_error', 'internal_error']);

/**
 * POST /analyzeMeal
 *
 * 1. authenticate (withAuth)
 * 2. validate request body (parseJsonBody)
 * 3. enforce image size limit (assertImageWithinSizeLimit)
 * 4. check AND consume one scan against the free-tier daily quota
 *    (consumeScanIfAllowed) — rejects with 429 scan_limit_reached before
 *    any AI work happens; see services/usage/scanLimit.ts for the full
 *    policy (what counts as a scan, reset timezone, concurrency safety)
 * 5-12. AI vision -> validate structured output -> normalize -> USDA
 *    match -> deterministic calculation -> confidence -> clarification
 *    (all in services/analysis/analyzePipeline.ts, kept separate from
 *    this handler so it's directly testable with mocked providers)
 * 13. persist pending analysis (no image data — see analysisStore.ts)
 * 14. return the mobile API contract, extended with `quota` (additive,
 *     backward-compatible — see types/api.ts's AnalyzeMealResponse)
 *
 * Image privacy: `body.imageBase64` is read once above, passed directly
 * to the vision provider, and never stored, logged, or echoed back in
 * any response or error from this handler.
 */
export const analyzeMealHandler = withAuth(async (req: Request, res: Response, { uid }) => {
  const body = await parseJsonBody(req, analyzeMealRequestSchema);
  assertImageWithinSizeLimit(body.imageBase64);

  // Backend-authoritative free-tier scan quota (see
  // services/usage/scanLimit.ts for the full policy). This is checked AND
  // consumed atomically here, before getVisionProvider()/
  // runAnalyzePipeline() are called below — an exhausted or
  // entitlement-denied request never reaches the AI provider or USDA, so
  // it can never consume AI API credits.
  const quota = await consumeScanIfAllowed(uid);
  if (!quota.allowed) {
    throw new ApiRouteError('scan_limit_reached', quota.reason ?? 'You have reached your daily scan limit.');
  }

  // Trust the actual image bytes over the client's claimed mimeType — see
  // detectImageMimeType's doc comment. Anthropic rejects the request
  // outright on a mismatch, so this must be corrected before the vision
  // call, not after.
  const mimeType = detectImageMimeType(body.imageBase64) ?? body.mimeType;

  let pipelineResult: Awaited<ReturnType<typeof runAnalyzePipeline>>;
  let analysisId: string;
  try {
    pipelineResult = await runAnalyzePipeline(
      { imageBase64: body.imageBase64, mimeType },
      { visionProvider: getVisionProvider(), lookupProvider: getNutritionLookupProvider() },
    );
    ({ analysisId } = await createPendingAnalysis({
      uid,
      aiResult: pipelineResult.aiResult,
      foodMatches: pipelineResult.foodMatches,
      prediction: pipelineResult.prediction,
      clarificationQuestions: pipelineResult.clarificationQuestions.length > 0 ? pipelineResult.clarificationQuestions : undefined,
    }));
  } catch (err) {
    // Give the free scan back when the failure is on our side (AI/USDA
    // outage or timeout, internal error) — see refundScan. Not for
    // invalid_request (e.g. no food in the photo): the scan did its job.
    if (!(err instanceof ApiRouteError) || REFUNDABLE_ERROR_CODES.has(err.code)) {
      await refundScan(uid, quota);
    }
    throw err;
  }
  const { prediction, clarificationQuestions } = pipelineResult;

  const response: AnalyzeMealResponse = {
    analysisId,
    prediction,
    needsClarification: clarificationQuestions.length > 0,
    clarificationQuestions: clarificationQuestions.length > 0 ? clarificationQuestions : undefined,
    quota: {
      entitlement: quota.entitlement,
      scansUsedToday: quota.scansUsedToday,
      scansRemainingToday: quota.scansRemainingToday,
      dailyScanLimit: quota.dailyScanLimit,
    },
  };

  jsonSuccess(res, response);
});
