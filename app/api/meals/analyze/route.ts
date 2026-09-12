import type { NextRequest } from 'next/server';
import { withAuth } from '@/lib/auth';
import { ApiRouteError, jsonSuccess } from '@/lib/apiResponse';
import { analyzeMealRequestSchema, assertImageWithinSizeLimit, detectImageMimeType, parseJsonBody } from '@/lib/validation';
import { consumeScanIfAllowed } from '@/services/usage/scanLimit';
import { getVisionProvider } from '@/services/ai/visionProvider';
import { getNutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import { runAnalyzePipeline } from '@/services/analysis/analyzePipeline';
import { createPendingAnalysis } from '@/services/analysis/analysisStore';
import type { AnalyzeMealResponse } from '@/types/api';

/**
 * Without this, Vercel's platform-default function timeout (10s on Hobby,
 * 15s on Pro — well under this route's own internal budget) kills the
 * request while the AI vision call (ANTHROPIC_REQUEST_TIMEOUT_MS, up to
 * 30s) or the USDA lookup pipeline (several sequential/fallback calls,
 * USDA_REQUEST_TIMEOUT_MS each, per food item) is still in flight. A
 * platform-level timeout returns a raw 500 with no JSON body — bypassing
 * this route's own structured error handling entirely — which is why the
 * mobile app sometimes shows the generic "Request failed with status 500"
 * fallback (services/api.ts's authedFetch) instead of one of this route's
 * own descriptive ApiRouteError messages. 60s covers the worst case
 * (Anthropic timeout + a few USDA round-trips) with headroom, and is the
 * max allowed on Vercel's Hobby plan.
 */
export const maxDuration = 60;

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

  // Trust the actual image bytes over the client's claimed mimeType — see
  // detectImageMimeType's doc comment. Anthropic rejects the request
  // outright on a mismatch, so this must be corrected before the vision
  // call, not after.
  const mimeType = detectImageMimeType(body.imageBase64) ?? body.mimeType;

  const { aiResult, foodMatches, prediction, clarificationQuestions } = await runAnalyzePipeline(
    { imageBase64: body.imageBase64, mimeType },
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
