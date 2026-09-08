import { z } from 'zod';

/**
 * Environment variable access for the backend.
 *
 * Deliberately LAZY: these schemas are only parsed when a getter is
 * called (e.g. from lib/firebaseAdmin.ts on first use inside a route
 * handler), never at module import time. Route handler files get
 * imported during `next build` for static analysis — if env parsing ran
 * at import time, a build would fail in any environment without real
 * secrets configured (e.g. CI, or this sandbox). Validating lazily means
 * `next build`/typecheck succeed everywhere, and a clear, structured
 * error only appears if a route handler actually runs without the
 * required configuration.
 *
 * IMPORTANT: nothing in this file is ever exposed to the Expo app. None
 * of these are prefixed NEXT_PUBLIC_, which is Next.js's signal to inline
 * a value into a client bundle — these stay server-only by construction.
 */

const firebaseAdminEnvSchema = z.object({
  FIREBASE_ADMIN_PROJECT_ID: z.string().min(1, 'FIREBASE_ADMIN_PROJECT_ID is required'),
  FIREBASE_ADMIN_CLIENT_EMAIL: z.string().min(1, 'FIREBASE_ADMIN_CLIENT_EMAIL is required'),
  FIREBASE_ADMIN_PRIVATE_KEY: z.string().min(1, 'FIREBASE_ADMIN_PRIVATE_KEY is required'),
});

export function getFirebaseAdminEnv() {
  const result = firebaseAdminEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Missing/invalid Firebase Admin environment variables: ${result.error.issues.map((i) => i.message).join('; ')}. Copy .env.example to .env.local and fill in your Firebase service account.`,
    );
  }
  return {
    projectId: result.data.FIREBASE_ADMIN_PROJECT_ID,
    clientEmail: result.data.FIREBASE_ADMIN_CLIENT_EMAIL,
    // Service account private keys in env vars typically arrive with
    // literal "\n" sequences instead of real newlines (most hosts,
    // including Vercel, don't preserve multi-line env values cleanly).
    privateKey: result.data.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
}

const appEnvSchema = z.object({
  ANALYSIS_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /**
   * Max accepted size (bytes, decoded) for an uploaded meal photo.
   * Deployment-specific in practice — e.g. Vercel serverless functions
   * have historically capped request bodies well under typical raw photo
   * sizes — but kept as a plain configurable number here rather than
   * hardcoding any platform's specific limit, so this isn't coupled to
   * Vercel if the deployment target changes later.
   */
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
});

export function getAppEnv() {
  const result = appEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid app environment variables: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}

const usdaEnvSchema = z.object({
  USDA_FDC_API_KEY: z.string().min(1, 'USDA_FDC_API_KEY is required'),
  USDA_FDC_BASE_URL: z.string().url().default('https://api.nal.usda.gov/fdc/v1'),
  /** Milliseconds before a USDA request is aborted. Deliberately generous — USDA's public API can be slow under load. */
  USDA_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
});

export function getUsdaEnv() {
  const result = usdaEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Missing/invalid USDA FoodData Central environment variables: ${result.error.issues.map((i) => i.message).join('; ')}. Get a free key at https://fdc.nal.usda.gov/api-key-signup.html and set USDA_FDC_API_KEY.`,
    );
  }
  return result.data;
}

/**
 * Anthropic Claude — the AI vision provider chosen for this phase (see
 * services/ai/providers/anthropicVisionProvider.ts for the rationale:
 * native vision support + forced structured tool-use output). No
 * particular vendor was specified when this was built, so this is a
 * documented default, not a hardcoded assumption baked into the
 * `VisionProvider` interface itself — swapping providers later means
 * writing one new file, not touching route/service code.
 *
 * `ANTHROPIC_VISION_MODEL` defaults to `claude-sonnet-5`, a current,
 * vision-capable model as of this update. Model lineups change over
 * time — this stays overridable via the env var so a newer model can be
 * adopted without a code change.
 */
const anthropicEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ANTHROPIC_VISION_MODEL: z.string().min(1).default('claude-sonnet-5'),
  ANTHROPIC_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
});

export function getAnthropicEnv() {
  const result = anthropicEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Missing/invalid Anthropic environment variables: ${result.error.issues.map((i) => i.message).join('; ')}. Get a key at https://console.anthropic.com/ and set ANTHROPIC_API_KEY.`,
    );
  }
  return result.data;
}

/**
 * Cloudinary — durable meal-photo storage (see
 * services/media/cloudinaryImageStorageProvider.ts). Chosen over Firebase
 * Storage because this project is on the Firebase Spark (free, no billing
 * account) plan, and Firebase now requires upgrading to the Blaze plan
 * (linking a billing account) before Cloud Storage for Firebase can be
 * enabled at all, even for free-tier usage — see
 * calhow-mobile/services/mealImagePersistence.ts for the full option
 * comparison. Cloudinary's free tier needs no billing account.
 *
 * `CLOUDINARY_API_SECRET` is a genuine secret (used for HTTP Basic Auth
 * against Cloudinary's upload API) — server-only by construction, same as
 * every other credential in this file.
 */
const cloudinaryEnvSchema = z.object({
  CLOUDINARY_CLOUD_NAME: z.string().min(1, 'CLOUDINARY_CLOUD_NAME is required'),
  CLOUDINARY_API_KEY: z.string().min(1, 'CLOUDINARY_API_KEY is required'),
  CLOUDINARY_API_SECRET: z.string().min(1, 'CLOUDINARY_API_SECRET is required'),
});

export function getCloudinaryEnv() {
  const result = cloudinaryEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Missing/invalid Cloudinary environment variables: ${result.error.issues.map((i) => i.message).join('; ')}. Create a free account at https://cloudinary.com/users/register/free and copy the Cloud name/API Key/API Secret from your Dashboard.`,
    );
  }
  return result.data;
}

/**
 * RevenueCat — server-side entitlement verification (see
 * services/usage/entitlement.ts / services/usage/revenueCatClient.ts).
 *
 * `REVENUECAT_SECRET_API_KEY` is the RevenueCat **secret** API key (starts
 * with `sk_`), used only for server-to-server calls to RevenueCat's REST
 * API (`GET /v1/subscribers/{app_user_id}`) to independently verify
 * whether a user actually has an active `calhow_pro` entitlement. This is
 * NOT the same key as the mobile app's RevenueCat *public* SDK key
 * (`EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` / `_ANDROID_API_KEY`, starting
 * with `appl_`/`goog_`, safe to ship in the client bundle) — the secret
 * key must never reach the Expo app, same server-only rule as every other
 * credential in this file.
 */
const revenueCatEnvSchema = z.object({
  REVENUECAT_SECRET_API_KEY: z.string().min(1, 'REVENUECAT_SECRET_API_KEY is required'),
});

export function getRevenueCatEnv() {
  const result = revenueCatEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Missing/invalid RevenueCat environment variables: ${result.error.issues.map((i) => i.message).join('; ')}. Get the secret API key from the RevenueCat dashboard -> Project Settings -> API Keys (the "secret" key, not a public SDK key) and set REVENUECAT_SECRET_API_KEY.`,
    );
  }
  return result.data;
}
