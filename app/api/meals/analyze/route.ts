import type { NextRequest } from 'next/server';
import { withAuth } from '@/lib/auth';
import { ApiRouteError, jsonSuccess } from '@/lib/apiResponse';
import { analyzeMealRequestSchema, assertImageWithinSizeLimit, parseJsonBody } from '@/lib/validation';
import { consumeScanIfAllowed } from '@/services/usage/scanLimit';
import { getVisionProvider } from '@/services/ai/visionProvider';
import { getNutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import { runAnalyzePipeline } from '@/services/analysis/analyzePipeline';
import { createPendingAnalysis } from '@/services/analysis/analysisStore';
import type { AnalyzeMealResponse } from '@/types/api';

/**
 * POST /api/meals/analyze
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
 *    this route so it's directly testable with mocked providers)
 * 13. persist pending analysis (no image data — see analysisStore.ts)
 * 14. return the mobile API contract, extended with `quota` (additive,
 *     backward-compatible — see types/api.ts's AnalyzeMealResponse)
 *
 * Image privacy: `body.imageBase64` is read once above, passed directly
 * to the vision provider, and never stored, logged, or echoed back in
 * any response or error from this route.
 */
export const POST = withAuth(async (req: NextRequest, { uid }) => {
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

  const { aiResult, foodMatches, prediction, clarificationQuestions } = await runAnalyzePipeline(
    { imageBase64: body.imageBase64, mimeType: body.mimeType },
    { visionProvider: getVisionProvider(), lookupProvider: getNutritionLookupProvider() },
  );

  const { analysisId } = await createPendingAnalysis({
    uid,
    aiResult,
    foodMatches,
    prediction,
    clarificationQuestions: clarificationQuestions.length > 0 ? clarificationQuestions : undefined,
  });

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

  return jsonSuccess(response);
});
