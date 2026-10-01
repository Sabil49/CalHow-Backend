import type { Request, Response } from 'express';
import { withAuth } from '@/lib/auth';
import { jsonSuccess } from '@/lib/apiResponse';
import { assertImageWithinSizeLimit, detectImageMimeType, estimateMenuDishRequestSchema, parseJsonBody, scanMenuRequestSchema } from '@/lib/validation';
import { getAnthropicEnv } from '@/lib/env';
import { assertPro } from '@/services/usage/requirePro';
import { getNutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import { createPendingAnalysis } from '@/services/analysis/analysisStore';
import { estimateMenuDish, estimateMenuDishes, readMenu, type MenuDishResult } from '@/services/menu/menuScan';
import type { AiMealPrediction, ClarificationQuestion } from '@/types/models';

/**
 * POST /scanMenu — CalHow Pro "Restaurant & Menu Scanner". See
 * services/menu/menuScan.ts for how dishes are estimated.
 *
 * Every dish with an estimate is stored as a normal pending analysis, so
 * the app logs it through the same review -> recalculate -> save flow as a
 * meal photo (the analysisId is all it needs). Not counted against the
 * free scan quota: Pro-only, and Pro scans are unlimited.
 *
 * Image privacy: same as /analyzeMeal — the photo goes to the AI provider
 * only and is never stored or logged.
 */

export interface ScanMenuDish {
  name: string;
  description?: string;
  analysisId?: string;
  prediction?: AiMealPrediction;
  needsClarification?: boolean;
  clarificationQuestions?: ClarificationQuestion[];
  unavailableReason?: string;
  /** Not estimated yet — send to POST /estimateMenuDish (with name/description) to estimate it. */
  pending?: MenuDishResult['pending'];
}

/** Stores an estimated dish as a pending analysis (so it can be logged through review) and shapes it for the app. */
export async function toScanMenuDish(uid: string, result: MenuDishResult): Promise<ScanMenuDish> {
  if (!result.estimate) {
    return { name: result.name, description: result.description, unavailableReason: result.unavailableReason, pending: result.pending };
  }
  const { aiResult, foodMatches, prediction, clarificationQuestions } = result.estimate;
  const hasQuestions = clarificationQuestions.length > 0;
  const { analysisId } = await createPendingAnalysis({
    uid,
    aiResult,
    foodMatches,
    prediction,
    clarificationQuestions: hasQuestions ? clarificationQuestions : undefined,
  });
  return {
    name: result.name,
    description: result.description,
    analysisId,
    prediction,
    needsClarification: hasQuestions,
    clarificationQuestions: hasQuestions ? clarificationQuestions : undefined,
  };
}

export interface ScanMenuResponse {
  dishes: ScanMenuDish[];
}

export const scanMenuHandler = withAuth(async (req: Request, res: Response, { uid }) => {
  const body = parseJsonBody(req, scanMenuRequestSchema);
  assertImageWithinSizeLimit(body.imageBase64);
  await assertPro(uid);

  const mimeType = detectImageMimeType(body.imageBase64) ?? body.mimeType;
  const { menu, model } = await readMenu({ imageBase64: body.imageBase64, mimeType });
  const results = await estimateMenuDishes(menu, model, getNutritionLookupProvider());

  const dishes = await Promise.all(results.map((result) => toScanMenuDish(uid, result)));

  const response: ScanMenuResponse = { dishes };
  jsonSuccess(res, response);
});

/** POST /estimateMenuDish — estimates one dish a menu scan left `pending`. Pro only. */
export const estimateMenuDishHandler = withAuth(async (req: Request, res: Response, { uid }) => {
  const body = parseJsonBody(req, estimateMenuDishRequestSchema);
  await assertPro(uid);

  const { ANTHROPIC_MENU_MODEL } = getAnthropicEnv();
  const result = await estimateMenuDish(
    { name: body.name, description: body.description ?? '', confidence: body.confidence, components: body.components },
    ANTHROPIC_MENU_MODEL,
    getNutritionLookupProvider(),
  );
  const dish: ScanMenuDish = await toScanMenuDish(uid, result);
  jsonSuccess(res, dish);
});
