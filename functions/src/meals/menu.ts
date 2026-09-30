import type { Request, Response } from 'express';
import { withAuth } from '@/lib/auth';
import { jsonSuccess } from '@/lib/apiResponse';
import { assertImageWithinSizeLimit, detectImageMimeType, parseJsonBody, scanMenuRequestSchema } from '@/lib/validation';
import { assertPro } from '@/services/usage/requirePro';
import { getNutritionLookupProvider } from '@/services/nutrition/nutritionLookup';
import { createPendingAnalysis } from '@/services/analysis/analysisStore';
import { estimateMenuDishes, readMenu } from '@/services/menu/menuScan';
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

  const dishes = await Promise.all(
    results.map(async (result): Promise<ScanMenuDish> => {
      if (!result.estimate) {
        return { name: result.name, description: result.description, unavailableReason: result.unavailableReason };
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
    }),
  );

  const response: ScanMenuResponse = { dishes };
  jsonSuccess(res, response);
});
