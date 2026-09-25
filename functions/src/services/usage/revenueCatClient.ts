import { getRevenueCatEnv } from '@/lib/env';

/**
 * Thin HTTP client for RevenueCat's REST API **v2** — isolated here so
 * nothing else in the codebase constructs a RevenueCat URL or handles its
 * response shape directly (same "one file owns the vendor's wire format"
 * convention as services/nutrition/usda/usdaClient.ts). Raw `fetch`, no
 * SDK dependency — this is a single read-only endpoint.
 *
 * Docs: https://www.revenuecat.com/docs/api-v2/customer/resources
 * (GET /projects/{project_id}/customers/{customer_id}/active_entitlements)
 *
 * WHY V2, NOT V1: this app originally called v1's
 * `GET /subscribers/{app_user_id}` (still referenced by that name in
 * git history), which fails with a 403 ("secret API key incompatible
 * with RevenueCat API V1") against a v2-generated secret key — RevenueCat
 * v1 and v2 keys are mutually incompatible with the other version's REST
 * API. v2's `active_entitlements` endpoint is also simpler to consume
 * than v1's subscriber object: RevenueCat has already resolved whether
 * each entitlement is currently active (including Apple/Google
 * billing-retry grace periods) — anything this endpoint returns IS
 * active right now, so the caller doesn't need to separately compare
 * `expires_date`/`grace_period_expires_date` against the current time.
 *
 * The exact wrapper key for the item list (`items`) and the "customer
 * never seen by RevenueCat" behavior (treated here as 404 -> null,
 * mirroring v1's semantics) are the standard v2 list-endpoint pattern,
 * but weren't independently confirmed against a live RevenueCat response
 * while writing this. That's an acceptable risk: services/usage/
 * entitlement.ts fails closed to 'free' on ANY error or unexpected shape
 * from this client, so a wrong assumption here degrades to "Pro
 * subscribers are incorrectly rate-limited" (annoying, safe) rather than
 * "free users get Pro for free" (a real cost/security problem). Verify
 * against a real account with an active subscription before relying on
 * this for production billing decisions.
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

export interface RevenueCatCustomer {
  /**
   * Entitlements currently active for this customer, by LOOKUP KEY (the
   * human identifier set in the dashboard, e.g. `calhow_pro` — the same
   * string the mobile SDK's `entitlements.active[...]` is keyed by). An
   * entitlement whose lookup key couldn't be resolved is listed by its raw
   * internal id instead. RevenueCat has already resolved expiry and
   * billing-retry grace periods server-side — membership in this list
   * means "grants access right now", full stop, no further date math
   * needed by the caller.
   */
  activeEntitlementIds: string[];
}

interface ActiveEntitlementsResponse {
  items?: { entitlement_id?: string }[];
}

interface EntitlementsListResponse {
  items?: { id?: string; lookup_key?: string }[];
}

/**
 * v2's active_entitlements items carry only the entitlement's INTERNAL id
 * (e.g. "entla1b2c3d4e5"), never its lookup key — so comparing them to
 * `calhow_pro` directly never matches and every Pro subscriber reads as
 * Free. This maps internal id -> lookup key via
 * `GET /v2/projects/{project_id}/entitlements`. Entitlements are project
 * configuration that almost never changes, so the map is cached for the
 * life of the function instance and only refetched when an unknown id
 * shows up. Needs the secret key's "project configuration: entitlements"
 * read permission; without it this throws, and entitlement.ts fails
 * closed (logged) exactly as for any other RevenueCat error.
 */
let entitlementLookupKeys: Map<string, string> | null = null;

async function fetchEntitlementLookupKeys(): Promise<Map<string, string>> {
  const { REVENUECAT_SECRET_API_KEY, REVENUECAT_PROJECT_ID } = getRevenueCatEnv();
  const url = `https://api.revenuecat.com/v2/projects/${encodeURIComponent(REVENUECAT_PROJECT_ID)}/entitlements?limit=100`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${REVENUECAT_SECRET_API_KEY}` } });
  } catch (err) {
    throw new RevenueCatApiError('Could not reach RevenueCat.', err);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new RevenueCatApiError(`RevenueCat entitlements lookup failed with status ${response.status}. ${bodyText.slice(0, 200)}`);
  }

  let data: EntitlementsListResponse;
  try {
    data = (await response.json()) as EntitlementsListResponse;
  } catch (err) {
    throw new RevenueCatApiError('RevenueCat returned a malformed response.', err);
  }

  const map = new Map<string, string>();
  for (const item of data.items ?? []) {
    if (item.id && item.lookup_key) map.set(item.id, item.lookup_key);
  }
  return map;
}

async function resolveLookupKeys(internalIds: string[]): Promise<string[]> {
  if (internalIds.length === 0) return [];
  if (!entitlementLookupKeys || internalIds.some((id) => !entitlementLookupKeys!.has(id))) {
    entitlementLookupKeys = await fetchEntitlementLookupKeys();
  }
  const map = entitlementLookupKeys;
  return internalIds.map((id) => map.get(id) ?? id);
}

/** Test-only: clears the cached id -> lookup key map between tests. */
export function resetEntitlementLookupCacheForTests(): void {
  entitlementLookupKeys = null;
}

/**
 * Fetches `customerId`'s (the Firebase uid, logged into the RevenueCat
 * SDK as the App User ID — see calhow-mobile/services/purchases.ts)
 * currently-active entitlements from RevenueCat. Returns `null`
 * specifically for a 404 (RevenueCat has never seen this customer id —
 * e.g. the user has never opened the paywall/initialized the SDK), which
 * is a normal, expected "no entitlements" case, not an error. Any other
 * non-2xx response, or a network failure, throws `RevenueCatApiError` —
 * the caller (services/usage/entitlement.ts) decides how to fail safely.
 */
export async function fetchRevenueCatActiveEntitlements(customerId: string): Promise<RevenueCatCustomer | null> {
  const { REVENUECAT_SECRET_API_KEY, REVENUECAT_PROJECT_ID } = getRevenueCatEnv();

  const url = `https://api.revenuecat.com/v2/projects/${encodeURIComponent(REVENUECAT_PROJECT_ID)}/customers/${encodeURIComponent(customerId)}/active_entitlements`;

  let response: Response;
  try {
    response = await fetch(url, {
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
    throw new RevenueCatApiError(`RevenueCat active-entitlements lookup failed with status ${response.status}. ${bodyText.slice(0, 200)}`);
  }

  let data: ActiveEntitlementsResponse;
  try {
    data = (await response.json()) as ActiveEntitlementsResponse;
  } catch (err) {
    throw new RevenueCatApiError('RevenueCat returned a malformed response.', err);
  }

  const internalIds = (data.items ?? [])
    .map((item) => item.entitlement_id)
    .filter((id): id is string => Boolean(id));

  return { activeEntitlementIds: await resolveLookupKeys(internalIds) };
}
