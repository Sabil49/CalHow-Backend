import { z } from 'zod';

/**
 * Environment variable access for the functions.
 *
 * Deliberately LAZY: these schemas are only parsed when a getter is
 * called, never at module import time — so a deploy/typecheck never fails
 * in an environment without real secrets configured (e.g. this sandbox).
 * A clear, structured error only appears if a handler actually runs
 * without the required configuration.
 *
 * Real secrets (ANTHROPIC_API_KEY, USDA_FDC_API_KEY,
 * REVENUECAT_SECRET_API_KEY) are managed via Firebase's Secret Manager
 * integration (`firebase functions:secrets:set NAME`), bound to each
 * function in functions/src/index.ts — Cloud Functions injects them into
 * `process.env` at runtime, so they're read here exactly like any other
 * env var. Non-secret config (ANALYSIS_TTL_MINUTES, MAX_IMAGE_BYTES,
 * ANTHROPIC_VISION_MODEL, ...) comes from functions/.env, which Firebase
 * Functions v2 loads natively — see functions/.env.example.
 */

const appEnvSchema = z.object({
  ANALYSIS_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /** Max accepted size (bytes, decoded) for an uploaded meal photo. */
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
 * writing one new file, not touching handler/service code.
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
 * RevenueCat — server-side entitlement verification (see
 * services/usage/entitlement.ts / services/usage/revenueCatClient.ts).
 *
 * `REVENUECAT_SECRET_API_KEY` is the RevenueCat **secret** API key, used
 * only for server-to-server calls to RevenueCat's REST API **v2**
 * (`GET /v2/projects/{project_id}/customers/{customer_id}/active_entitlements`)
 * to independently verify whether a user actually has an active
 * `calhow_pro` entitlement. This is NOT the same key as the mobile app's
 * RevenueCat *public* SDK key (`EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` /
 * `_ANDROID_API_KEY`, safe to ship in the client bundle) — the secret key
 * must never reach the Expo app, same server-only rule as every other
 * credential in this file.
 *
 * `REVENUECAT_PROJECT_ID` is required by every v2 endpoint as a URL path
 * segment. Find both values in the RevenueCat dashboard -> Project
 * Settings -> API Keys. RevenueCat v1 secret keys do NOT work against v2
 * endpoints (and vice versa) — if you rotate this key, generate a v2
 * secret key, not a legacy v1 one.
 */
const revenueCatEnvSchema = z.object({
  REVENUECAT_SECRET_API_KEY: z.string().min(1, 'REVENUECAT_SECRET_API_KEY is required'),
  REVENUECAT_PROJECT_ID: z.string().min(1, 'REVENUECAT_PROJECT_ID is required'),
});

export function getRevenueCatEnv() {
  const result = revenueCatEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Missing/invalid RevenueCat environment variables: ${result.error.issues.map((i) => i.message).join('; ')}. Get the project ID and a v2 secret API key from the RevenueCat dashboard -> Project Settings -> API Keys, and set REVENUECAT_PROJECT_ID / REVENUECAT_SECRET_API_KEY.`,
    );
  }
  return result.data;
}
