import { getRevenueCatEnv } from '@/lib/env';

/**
 * Thin HTTP client for RevenueCat's REST API v1 — isolated here so
 * nothing else in the codebase constructs a RevenueCat URL or handles its
 * response shape directly (same "one file owns the vendor's wire format"
 * convention as services/nutrition/usda/usdaClient.ts). Raw `fetch`, no
 * SDK dependency — this is a single read-only endpoint.
 *
 * Docs: https://www.revenuecat.com/docs/api-v1#tag/subscribers/get/subscribers/{app_user_id}
 */

export class RevenueCatApiError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RevenueCatApiError';
  }
}

/** The subset of one entitlement's fields this app actually needs from a RevenueCat subscriber record. */
export interface RevenueCatSubscriberEntitlement {
  /** ISO 8601, or null for a non-expiring (e.g. lifetime/promotional) entitlement. */
  expires_date: string | null;
  /**
   * Present during Apple/Google's billing-retry grace period after a
   * failed renewal payment — the user should still be treated as
   * entitled until this passes, even though `expires_date` itself may
   * already be in the past.
   */
  grace_period_expires_date?: string | null;
  product_identifier?: string;
}

export interface RevenueCatSubscriber {
  entitlements: Record<string, RevenueCatSubscriberEntitlement>;
}

/**
 * Fetches `appUserId`'s subscriber record from RevenueCat. Returns `null`
 * specifically for a 404 (RevenueCat has never seen this app_user_id —
 * e.g. the user has never opened the paywall/initialized the SDK), which
 * is a normal, expected "no entitlements" case, not an error. Any other
 * non-2xx response, or a network failure, throws `RevenueCatApiError` —
 * the caller (services/usage/entitlement.ts) decides how to fail safely.
 */
export async function fetchRevenueCatSubscriber(appUserId: string): Promise<RevenueCatSubscriber | null> {
  const { REVENUECAT_SECRET_API_KEY } = getRevenueCatEnv();

  let response: Response;
  try {
    response = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
      headers: { Authorization: `Bearer ${REVENUECAT_SECRET_API_KEY}` },
    });
  } catch (err) {
    throw new RevenueCatApiError('Could not reach RevenueCat.', err);
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new RevenueCatApiError(`RevenueCat subscriber lookup failed with status ${response.status}. ${bodyText.slice(0, 200)}`);
  }

  let data: { subscriber?: RevenueCatSubscriber };
  try {
    data = (await response.json()) as { subscriber?: RevenueCatSubscriber };
  } catch (err) {
    throw new RevenueCatApiError('RevenueCat returned a malformed response.', err);
  }

  return data.subscriber ?? { entitlements: {} };
}
