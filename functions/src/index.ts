import { onRequest } from 'firebase-functions/v2/https';
import { analyzeMealHandler } from './meals/analyze';
import { clarifyMealHandler } from './meals/clarify';
import { recalculateMealHandler } from './meals/recalculate';
import { uploadMealImageHandler } from './meals/image';

/**
 * Cloud Functions v2 HTTPS entry points — one per mobile API endpoint,
 * replacing the old Next.js routes under app/api/meals/*. Each deploys to
 * `https://{region}-{project}.cloudfunctions.net/{functionName}`, so
 * calhow-mobile/services/api.ts just needs its base URL + these four path
 * names; the request/response contract (Bearer auth, JSON body,
 * `{ error: { code, message } }` on failure) is unchanged from before.
 *
 * `secrets` binds Secret Manager values into `process.env` for that
 * function only — set them once with e.g.
 * `firebase functions:secrets:set ANTHROPIC_API_KEY`. `timeoutSeconds`/
 * `memory` mirror the old Vercel `maxDuration`/default-memory choices:
 * AI vision + several sequential USDA lookups can run close to a minute,
 * and image decoding/upload benefits from headroom above the 256MiB
 * default.
 */
const ANALYSIS_SECRETS = ['ANTHROPIC_API_KEY', 'USDA_FDC_API_KEY', 'REVENUECAT_SECRET_API_KEY'];
const RUNTIME_OPTS = { timeoutSeconds: 60, memory: '512MiB' } as const;

export const analyzeMeal = onRequest({ ...RUNTIME_OPTS, secrets: ANALYSIS_SECRETS }, analyzeMealHandler);
export const clarifyMeal = onRequest({ ...RUNTIME_OPTS, secrets: ['USDA_FDC_API_KEY'] }, clarifyMealHandler);
export const recalculateMeal = onRequest({ ...RUNTIME_OPTS, secrets: ['USDA_FDC_API_KEY'] }, recalculateMealHandler);
export const uploadMealImage = onRequest(RUNTIME_OPTS, uploadMealImageHandler);
