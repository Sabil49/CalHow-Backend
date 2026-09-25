import { getUsdaEnv } from '@/lib/env';
import type { UsdaFoodDetailResponse, UsdaSearchResponse } from './types';

/**
 * Thin HTTP client for USDA FoodData Central. Isolated here so nothing
 * else in the codebase constructs a USDA URL or handles its
 * request/response shape directly — per the requirement to keep
 * USDA-specific code contained under services/nutrition/.
 *
 * The API key (USDA_FDC_API_KEY) is read via lib/env.ts, which is
 * server-only by construction — it is never sent to, or reachable from,
 * the Expo app.
 */

export class UsdaApiError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'UsdaApiError';
  }
}

const PREFERRED_DATA_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'] as const;

/**
 * `fetchWithTimeout` plus ONE retry on a timeout, network error, 429 or
 * 5xx — the transient failures behind "first scan fails, second works"
 * (a cold function instance's first outbound calls, or a slow USDA node).
 * 4xx other than 429 is a real answer and is returned as-is.
 */
async function fetchWithRetry(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetchWithTimeout(url, timeoutMs, init);
    if (response.status !== 429 && response.status < 500) return response;
  } catch (err) {
    if (!(err instanceof UsdaApiError)) throw err;
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  return fetchWithTimeout(url, timeoutMs, init);
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UsdaApiError(`USDA FoodData Central request timed out after ${timeoutMs}ms.`, err);
    }
    throw new UsdaApiError('Could not reach USDA FoodData Central.', err);
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonOrThrow<T>(response: Response, context: string): Promise<T> {
  if (!response.ok) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // ignore — body isn't essential to the error message
    }
    throw new UsdaApiError(`USDA FoodData Central ${context} failed with status ${response.status}. ${bodyText.slice(0, 200)}`);
  }
  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new UsdaApiError(`USDA FoodData Central ${context} returned malformed JSON.`, err);
  }
}

/**
 * Searches USDA FoodData Central for `query`, preferring generic
 * reference data (Foundation/SR Legacy/Survey) over Branded products —
 * see usdaMatcher.ts for why. `pageSize` caps how many candidates come
 * back for the matcher to score.
 *
 * Uses POST so dataType filters are sent as a JSON array in the body.
 * The GET equivalent (repeated dataType= params) is rejected intermittently
 * by USDA's nginx load balancer depending on which backend node handles
 * the request — confirmed via controlled matrix test 2026-09-04.
 */
export async function searchUsdaFoods(query: string, pageSize = 10): Promise<UsdaSearchResponse> {
  const { USDA_FDC_API_KEY, USDA_FDC_BASE_URL, USDA_REQUEST_TIMEOUT_MS } = getUsdaEnv();

  const params = new URLSearchParams({ api_key: USDA_FDC_API_KEY });
  const url = `${USDA_FDC_BASE_URL}/foods/search?${params.toString()}`;
  const response = await fetchWithRetry(url, USDA_REQUEST_TIMEOUT_MS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, pageSize, dataType: [...PREFERRED_DATA_TYPES] }),
  });
  return parseJsonOrThrow<UsdaSearchResponse>(response, `search for "${query}"`);
}

/**
 * A second, broader search WITHOUT the preferred-dataType filter — used
 * as a fallback only if the filtered search returns nothing, so a
 * Branded-only food isn't invisible just because it lacks a generic
 * reference entry (e.g. some prepared/mixed dishes only exist as Branded
 * products in USDA's data).
 */
export async function searchUsdaFoodsUnfiltered(query: string, pageSize = 10): Promise<UsdaSearchResponse> {
  const { USDA_FDC_API_KEY, USDA_FDC_BASE_URL, USDA_REQUEST_TIMEOUT_MS } = getUsdaEnv();

  const params = new URLSearchParams({ api_key: USDA_FDC_API_KEY });
  const url = `${USDA_FDC_BASE_URL}/foods/search?${params.toString()}`;
  const response = await fetchWithRetry(url, USDA_REQUEST_TIMEOUT_MS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, pageSize }),
  });
  return parseJsonOrThrow<UsdaSearchResponse>(response, `unfiltered search for "${query}"`);
}

/**
 * Fetches the full nutrient profile for one food. Called on the single
 * best candidate AFTER matching (see usdaNutritionLookupProvider.ts) —
 * search results can carry an abbreviated nutrient list, so the detail
 * endpoint is the authoritative source for the final per-100g numbers.
 */
export async function getUsdaFoodDetail(fdcId: number): Promise<UsdaFoodDetailResponse> {
  const { USDA_FDC_API_KEY, USDA_FDC_BASE_URL, USDA_REQUEST_TIMEOUT_MS } = getUsdaEnv();

  const params = new URLSearchParams({ api_key: USDA_FDC_API_KEY });
  const url = `${USDA_FDC_BASE_URL}/food/${fdcId}?${params.toString()}`;
  const response = await fetchWithRetry(url, USDA_REQUEST_TIMEOUT_MS);
  return parseJsonOrThrow<UsdaFoodDetailResponse>(response, `food detail for fdcId ${fdcId}`);
}
