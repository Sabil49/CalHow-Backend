import { fetchRevenueCatSubscriber, type RevenueCatSubscriber } from './revenueCatClient';

/**
 * Entitlement boundary — the ONLY place in this backend that decides
 * whether a user is Free or Pro. Every quota/gating decision (today:
 * services/usage/scanLimit.ts; any future Pro-gated feature) must go
 * through this function, never re-derive tier from anywhere else — and
 * never from anything a client sends on a request. Nothing in this
 * function's signature accepts a client-claimed tier/isPro flag; `uid`
 * (the verified Firebase Auth uid from `withAuth`) is the only input, and
 * the answer is always independently verified against RevenueCat's
 * server API below.
 *
 * ---------------------------------------------------------------------
 * VERIFICATION: RevenueCat REST API, keyed by Firebase uid
 * ---------------------------------------------------------------------
 * The mobile app logs the RevenueCat SDK in with the user's Firebase uid
 * as the RevenueCat App User ID (`Purchases.logIn(uid)` — see
 * calhow-mobile/services/purchases.ts), specifically so this function can
 * look a user up in RevenueCat using the SAME identifier this backend
 * already treats as canonical identity everywhere else, with no separate
 * id-mapping table to keep in sync. `fetchRevenueCatSubscriber(uid)` (see
 * ./revenueCatClient.ts) calls RevenueCat's `GET /v1/subscribers/{uid}`
 * using a server-only secret key (REVENUECAT_SECRET_API_KEY —
 * lib/env.ts) — this is a genuine second, independent check: even a
 * client that fakes every field it sends this backend cannot make
 * RevenueCat's own servers report an entitlement it doesn't actually have
 * from Apple/Google.
 *
 * An entitlement counts as active exactly when RevenueCat's own SDK-side
 * `EntitlementInfo.isActive` would: `expires_date` is null (non-expiring
 * — e.g. a lifetime/promotional grant) OR in the future, OR the
 * subscription is within Apple/Google's billing-retry grace period
 * (`grace_period_expires_date` in the future) after a failed renewal
 * payment. A CANCELLED subscription (auto-renew turned off) still reports
 * its current `expires_date` unchanged until the paid period actually
 * ends — so a cancelled-but-not-yet-expired subscriber is correctly
 * 'pro' here, and becomes 'free' the moment that date passes, with no
 * special-casing needed for "cancelled" as its own state.
 *
 * ---------------------------------------------------------------------
 * FAILURE POLICY: fail CLOSED (treat as 'free') on any RevenueCat error
 * ---------------------------------------------------------------------
 * A network failure, RevenueCat outage, timeout, or malformed response
 * from `fetchRevenueCatSubscriber` results in 'free', not 'pro' and not a
 * thrown error. This is a deliberate security trade-off, not an
 * oversight: failing OPEN (treating a lookup failure as 'pro') would mean
 * a RevenueCat outage silently grants unlimited free AI usage to EVERY
 * user, including non-paying ones — directly costing real Anthropic/USDA
 * API spend with no entitlement check at all, for as long as the outage
 * lasts. Failing closed instead means the worst case during an outage is
 * a real Pro subscriber being incorrectly rate-limited to the free daily
 * quota until RevenueCat recovers — a fairness cost to paying users, but
 * not a security or cost-control failure. There is no cached/last-known-
 * good entitlement snapshot in V1 to fall back on instead (a reasonable
 * V2 improvement — e.g. a short-TTL cache of the last successful lookup —
 * is not implemented here to keep this the smallest secure V1).
 *
 * ---------------------------------------------------------------------
 * users/{uid}.subscription IN FIRESTORE — still not trusted here
 * ---------------------------------------------------------------------
 * The mobile app may continue to write an informational
 * `users/{uid}.subscription` mirror (for offline-friendly UI display —
 * see calhow-mobile/services/purchases.ts) but this function still never
 * reads it, for the same reason V1 never did: per
 * calhow-mobile/firestore.rules, the owning user can write that field
 * directly via the Firestore client SDK, so it can never be treated as
 * proof of a real purchase — only RevenueCat's own server response, above,
 * can be.
 */

export type Entitlement = 'free' | 'pro';

export const CALHOW_PRO_ENTITLEMENT_ID = 'calhow_pro';

export interface EntitlementDeps {
  fetchSubscriber: (uid: string) => Promise<RevenueCatSubscriber | null>;
  now: () => Date;
}

const defaultDeps: EntitlementDeps = {
  fetchSubscriber: fetchRevenueCatSubscriber,
  now: () => new Date(),
};

/** True when `entitlement` grants access right now — active period, non-expiring, or within a billing-retry grace period. */
function isEntitlementActive(entitlement: RevenueCatSubscriber['entitlements'][string], now: Date): boolean {
  if (entitlement.expires_date === null) return true;

  const expiresAt = new Date(entitlement.expires_date).getTime();
  if (expiresAt > now.getTime()) return true;

  if (entitlement.grace_period_expires_date) {
    const graceUntil = new Date(entitlement.grace_period_expires_date).getTime();
    if (graceUntil > now.getTime()) return true;
  }

  return false;
}

export async function getUserEntitlement(uid: string, deps: EntitlementDeps = defaultDeps): Promise<Entitlement> {
  let subscriber: RevenueCatSubscriber | null;
  try {
    subscriber = await deps.fetchSubscriber(uid);
  } catch (err) {
    // See the FAILURE POLICY doc comment above — fail closed to 'free'.
    // eslint-disable-next-line no-console
    console.error('[entitlement] RevenueCat lookup failed; failing closed to "free"', err);
    return 'free';
  }

  if (!subscriber) return 'free'; // no RevenueCat customer record for this uid yet

  const entitlement = subscriber.entitlements[CALHOW_PRO_ENTITLEMENT_ID];
  if (!entitlement) return 'free';

  return isEntitlementActive(entitlement, deps.now()) ? 'pro' : 'free';
}
