import { onRequest } from 'firebase-functions/v2/https';
import * as functionsV1 from 'firebase-functions/v1';
import { deleteBackendUserData } from './account/deleteUserData';
import { analyzeMealHandler } from './meals/analyze';
import { clarifyMealHandler } from './meals/clarify';
import { recalculateMealHandler } from './meals/recalculate';
import { uploadMealImageHandler } from './meals/image';
import { mealInsightsHandler } from './meals/insights';
import { estimateMenuDishHandler, scanMenuHandler } from './meals/menu';
import { mealIdeasHandler } from './meals/mealIdeas';

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

// CalHow Pro. The menu scanner reads the photo AND estimates several dishes
// through USDA, so it gets a longer timeout than a single meal scan.
export const mealInsights = onRequest({ ...RUNTIME_OPTS, secrets: ['ANTHROPIC_API_KEY', 'REVENUECAT_SECRET_API_KEY'] }, mealInsightsHandler);
export const scanMenu = onRequest({ ...RUNTIME_OPTS, timeoutSeconds: 180, secrets: ANALYSIS_SECRETS }, scanMenuHandler);
export const estimateMenuDish = onRequest({ ...RUNTIME_OPTS, secrets: ANALYSIS_SECRETS }, estimateMenuDishHandler);
export const mealIdeas = onRequest({ ...RUNTIME_OPTS, timeoutSeconds: 120, secrets: ANALYSIS_SECRETS }, mealIdeasHandler);

// Account deletion cleanup: when the app deletes a Firebase Auth user,
// remove what only the backend can reach (meal photos, pending analyses).
// A v1 trigger because v2 has no non-blocking "user deleted" event.
export const onAccountDeleted = functionsV1.auth.user().onDelete((user) => deleteBackendUserData(user.uid));
