import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { analyzeMealHandler } from '../analyze';
import { ApiRouteError } from '@/lib/apiResponse';

/**
 * Handler-level test for the scan-quota gate. Every service call site the
 * handler touches is mocked (no real Firebase Admin credentials, no real
 * AI/USDA calls) so this is a pure test of HANDLER WIRING: does the quota
 * check run before the AI vision provider is ever invoked, does a denied
 * quota produce the documented 429 response, and does the response
 * include quota metadata when allowed. The quota DECISION logic itself
 * (allowed/denied thresholds, concurrency, reset, entitlement) is tested
 * separately and thoroughly in services/usage/__tests__/scanLimit.test.ts
 * — this file only proves the handler calls it correctly and respects its
 * answer.
 */

const verifyIdTokenMock = vi.fn();
vi.mock('@/lib/firebaseAdmin', () => ({
  getAdminAuth: () => ({ verifyIdToken: verifyIdTokenMock }),
}));

const consumeScanIfAllowedMock = vi.fn();
const refundScanMock = vi.fn();
vi.mock('@/services/usage/scanLimit', () => ({
  consumeScanIfAllowed: (...args: unknown[]) => consumeScanIfAllowedMock(...args),
  refundScan: (...args: unknown[]) => refundScanMock(...args),
}));

const getVisionProviderMock = vi.fn();
vi.mock('@/services/ai/visionProvider', () => ({
  getVisionProvider: (...args: unknown[]) => getVisionProviderMock(...args),
}));

const getNutritionLookupProviderMock = vi.fn();
vi.mock('@/services/nutrition/nutritionLookup', () => ({
  getNutritionLookupProvider: (...args: unknown[]) => getNutritionLookupProviderMock(...args),
}));

const runAnalyzePipelineMock = vi.fn();
vi.mock('@/services/analysis/analyzePipeline', () => ({
  runAnalyzePipeline: (...args: unknown[]) => runAnalyzePipelineMock(...args),
}));

const createPendingAnalysisMock = vi.fn();
vi.mock('@/services/analysis/analysisStore', () => ({
  createPendingAnalysis: (...args: unknown[]) => createPendingAnalysisMock(...args),
}));

function fakeReq(body: unknown, authHeader: string | null = 'Bearer valid-token'): Request {
  return { headers: { authorization: authHeader ?? undefined }, body } as unknown as Request;
}

function fakeRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const validBody = { imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg' };

describe('analyzeMealHandler — scan-quota gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyIdTokenMock.mockImplementation(async (token: string) => {
      if (token !== 'valid-token') throw new Error('invalid token');
      return { uid: 'test-uid' };
    });
    getVisionProviderMock.mockReturnValue({ analyzeMealImage: vi.fn() });
    getNutritionLookupProviderMock.mockReturnValue({ lookup: vi.fn() });
    runAnalyzePipelineMock.mockResolvedValue({
      aiResult: { detectedFoods: [], overallUncertainty: 0, modelVersion: 'test' },
      foodMatches: [],
      prediction: { foods: [], calories: 0, protein: 0, carbs: 0, fats: 0, confidence: 1, analyzedAt: new Date().toISOString() },
      clarificationQuestions: [],
    });
    createPendingAnalysisMock.mockResolvedValue({ analysisId: 'analysis-1', doc: {} });
  });

  it('rejects with 429 scan_limit_reached and NEVER calls the vision provider when quota is exhausted', async () => {
    consumeScanIfAllowedMock.mockResolvedValue({
      allowed: false,
      entitlement: 'free',
      scansUsedToday: 3,
      scansRemainingToday: 0,
      dailyScanLimit: 3,
      reason: "You've used all 3 free scans for today.",
    });

    const res = fakeRes();
    await analyzeMealHandler(fakeReq(validBody), res);

    expect(res.statusCode).toBe(429);
    expect((res.body as { error: { code: string } }).error.code).toBe('scan_limit_reached');
    expect(getVisionProviderMock).not.toHaveBeenCalled();
    expect(runAnalyzePipelineMock).not.toHaveBeenCalled();
    expect(createPendingAnalysisMock).not.toHaveBeenCalled();
  });

  it('proceeds to AI analysis and includes quota metadata in the response when allowed', async () => {
    consumeScanIfAllowedMock.mockResolvedValue({
      allowed: true,
      entitlement: 'free',
      scansUsedToday: 1,
      scansRemainingToday: 2,
      dailyScanLimit: 3,
    });

    const res = fakeRes();
    await analyzeMealHandler(fakeReq(validBody), res);

    expect(res.statusCode).toBe(200);
    expect(getVisionProviderMock).toHaveBeenCalledTimes(1);
    expect(runAnalyzePipelineMock).toHaveBeenCalledTimes(1);
    expect((res.body as { quota: unknown }).quota).toEqual({ entitlement: 'free', scansUsedToday: 1, scansRemainingToday: 2, dailyScanLimit: 3 });
  });

  it('a "pro" entitlement result from consumeScanIfAllowed proceeds to AI analysis with unlimited quota metadata', async () => {
    consumeScanIfAllowedMock.mockResolvedValue({
      allowed: true,
      entitlement: 'pro',
      scansUsedToday: null,
      scansRemainingToday: null,
      dailyScanLimit: null,
    });

    const res = fakeRes();
    await analyzeMealHandler(fakeReq(validBody), res);

    expect(res.statusCode).toBe(200);
    expect(getVisionProviderMock).toHaveBeenCalledTimes(1);
    expect((res.body as { quota: unknown }).quota).toEqual({ entitlement: 'pro', scansUsedToday: null, scansRemainingToday: null, dailyScanLimit: null });
  });

  it('unauthenticated request (no Authorization header) is rejected before quota/AI is ever touched', async () => {
    const res = fakeRes();
    await analyzeMealHandler(fakeReq(validBody, null), res);

    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('unauthenticated');
    expect(consumeScanIfAllowedMock).not.toHaveBeenCalled();
    expect(getVisionProviderMock).not.toHaveBeenCalled();
  });

  it('an invalid/expired token is rejected before quota/AI is touched', async () => {
    const res = fakeRes();
    await analyzeMealHandler(fakeReq(validBody, 'Bearer not-a-real-token'), res);

    expect(res.statusCode).toBe(401);
    expect(consumeScanIfAllowedMock).not.toHaveBeenCalled();
    expect(getVisionProviderMock).not.toHaveBeenCalled();
  });

  it('ignores a client-claimed Pro/isPro field in the request body — consumeScanIfAllowed is called with only the server-verified uid', async () => {
    consumeScanIfAllowedMock.mockResolvedValue({
      allowed: true,
      entitlement: 'free',
      scansUsedToday: 1,
      scansRemainingToday: 2,
      dailyScanLimit: 3,
    });

    await analyzeMealHandler(fakeReq({ ...validBody, isPro: true, subscription: { tier: 'pro' } }), fakeRes());

    expect(consumeScanIfAllowedMock).toHaveBeenCalledTimes(1);
    expect(consumeScanIfAllowedMock).toHaveBeenCalledWith('test-uid');
  });

  describe('refunds the consumed scan only for failures on our side', () => {
    const consumed = { allowed: true, entitlement: 'free', scansUsedToday: 1, scansRemainingToday: 2, dailyScanLimit: 3, consumedDateKey: '2026-09-25' };

    beforeEach(() => {
      consumeScanIfAllowedMock.mockResolvedValue(consumed);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('refunds on an AI provider / USDA failure and still returns the error', async () => {
      runAnalyzePipelineMock.mockRejectedValue(new ApiRouteError('nutrition_lookup_error', 'USDA timed out'));

      const res = fakeRes();
      await analyzeMealHandler(fakeReq(validBody), res);

      expect(res.statusCode).toBe(502);
      expect(refundScanMock).toHaveBeenCalledWith('test-uid', consumed);
    });

    it('does NOT refund when the photo simply has no food (invalid_request)', async () => {
      runAnalyzePipelineMock.mockRejectedValue(new ApiRouteError('invalid_request', 'No food items were detected'));

      await analyzeMealHandler(fakeReq(validBody), fakeRes());

      expect(refundScanMock).not.toHaveBeenCalled();
    });
  });
});
