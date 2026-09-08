import { FieldValue } from 'firebase-admin/firestore';
import { getAdminFirestore } from '@/lib/firebaseAdmin';
import { getUserEntitlement, type Entitlement } from './entitlement';

/**
 * Free-tier daily AI-scan quota — backend-authoritative enforcement (see
 * app/api/meals/analyze/route.ts, the only call site).
 *
 * This is the real implementation of what services/usage/scanLimit.ts
 * used to be scaffolding for. calhow-mobile/hooks/useFeatureGate.ts's
 * `FREE_DAILY_SCAN_LIMIT` constant describes the same number client-side
 * for optimistic UX ONLY — that constant does not enforce anything (a
 * client can be reinstalled, have its storage cleared, or call the API
 * directly with a manipulated request; none of that touches this file).
 * `DAILY_FREE_SCAN_LIMIT` below is the actual source of truth; keep the
 * two numbers in sync manually — same "hand-synced across repos"
 * convention already used for types/models.ts / types/api.ts.
 *
 * ---------------------------------------------------------------------
 * RESET POLICY: UTC calendar day (V1 decision — document before changing)
 * ---------------------------------------------------------------------
 * "Daily" means the UTC calendar day (`YYYY-MM-DD` per `Date#toISOString`),
 * not the user's local day. Nothing in this codebase currently captures a
 * trustworthy server-side user timezone (UserProfile has no timezone
 * field — see calhow-backend/types/models.ts / calhow-mobile's mirror),
 * so there is no server-authoritative "local day" to reset against; UTC
 * is the only option that doesn't require trusting a client-supplied
 * timezone. Practical effect: the reset instant is the same wall-clock
 * moment for every user regardless of where they are, which means it
 * lands at a different LOCAL time per user (e.g. a UTC+X user's quota
 * resets at X:00 local time). If a trustworthy user timezone is added
 * later, switching this to user-local-day means changing
 * `getUsageDateKeyUTC` (and the Firestore doc id it produces) — nothing
 * else in this module's design depends on the key being UTC specifically.
 *
 * ---------------------------------------------------------------------
 * FIRESTORE SCHEMA
 * ---------------------------------------------------------------------
 * `users/{uid}/scanUsage/{YYYY-MM-DD}`:
 *   { uid, date: "YYYY-MM-DD", scansUsed: number, updatedAt: Timestamp }
 *
 * Chosen as the smallest schema that fits the existing data architecture:
 * every other per-user collection in this app (meals, weightLogs,
 * corrections — see calhow-mobile/services/firestore.ts) is already a
 * subcollection under `users/{uid}`, so this follows the same shape
 * rather than introducing a new top-level collection or a rolling-window
 * structure V1 doesn't need. One doc per user per day keeps reads/writes
 * O(1) and needs no cleanup job (old day-docs are simply never read again;
 * a future TTL/cleanup job is a reasonable but non-urgent follow-up).
 *
 * This path is intentionally given NO Firestore Security Rule of its own
 * in calhow-mobile/firestore.rules — the existing top-level
 * `match /{document=**} { allow read, write: if false; }` catch-all
 * already denies it by default (it does not match the narrower
 * `match /users/{uid} { ... }` block, which only governs the profile doc
 * itself and its explicitly-listed nested matches). So the mobile client
 * can never read OR write its own usage counter directly — only the
 * Admin SDK (this file, server-only) can, which is what makes this
 * authoritative rather than advisory.
 *
 * ---------------------------------------------------------------------
 * WHEN a scan is consumed, and the policy on downstream AI/USDA failure
 * ---------------------------------------------------------------------
 * See `consumeScanIfAllowed`'s own doc comment below for the full policy
 * and rationale — summary: consumed atomically, in one Firestore
 * transaction, at the moment a request is about to be handed to the AI
 * pipeline (before the vision provider or USDA are ever called); NOT
 * refunded if the AI/USDA work that follows subsequently fails.
 *
 * ---------------------------------------------------------------------
 * CONCURRENCY
 * ---------------------------------------------------------------------
 * `ScanQuotaStore.incrementIfUnder` combines "read current count" and
 * "increment if under the limit" into ONE atomic operation (a Firestore
 * transaction in the real implementation below). That is what prevents
 * two simultaneous /api/meals/analyze requests for a user with exactly
 * one scan remaining from both succeeding: Firestore transactions
 * serialize conflicting reads/writes against the same document and retry
 * automatically on contention, so the second concurrent transaction
 * always observes the first one's committed increment before deciding
 * whether it's still under the limit. See
 * services/usage/__tests__/scanLimit.test.ts's concurrency test, which
 * exercises this via an in-memory fake store built with the same
 * single-atomic-operation contract.
 */
export const DAILY_FREE_SCAN_LIMIT = 3;

/** UTC calendar day key, e.g. "2026-09-05" — see the RESET POLICY section above. */
export function getUsageDateKeyUTC(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface ScanQuotaStatus {
  allowed: boolean;
  entitlement: Entitlement;
  /** Null for 'pro' — not tracked/limited, so "used today" isn't a meaningful number to report. */
  scansUsedToday: number | null;
  /** Null means unlimited (pro). */
  scansRemainingToday: number | null;
  /** Null means unlimited (pro). */
  dailyScanLimit: number | null;
  /** Present when allowed is false — human-readable, suitable for the error message shown to the user. */
  reason?: string;
}

/**
 * Atomic "read current count for (uid, dateKey); if under `limit`,
 * increment and return the new count" primitive. Pulled out as its own
 * interface — same pattern as
 * services/nutrition/nutritionLookup.ts's NutritionLookupProvider or
 * services/nutrition/usda/usdaNutritionLookupProvider.ts's
 * UsdaClientDeps — purely so tests can substitute an in-memory fake
 * instead of exercising a real Firestore transaction. See the module doc
 * comment's CONCURRENCY section for why this needs to be a single atomic
 * operation, not two separate "check" then "write" calls.
 */
export interface ScanQuotaStore {
  incrementIfUnder(uid: string, dateKey: string, limit: number): Promise<{ incremented: boolean; count: number }>;
}

/** Firestore-backed ScanQuotaStore — see the module doc comment's FIRESTORE SCHEMA and CONCURRENCY sections. */
export function createFirestoreScanQuotaStore(): ScanQuotaStore {
  return {
    async incrementIfUnder(uid, dateKey, limit) {
      const db = getAdminFirestore();
      const ref = db.collection('users').doc(uid).collection('scanUsage').doc(dateKey);

      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists ? ((snap.data()?.scansUsed as number | undefined) ?? 0) : 0;

        if (current >= limit) {
          return { incremented: false, count: current };
        }

        const next = current + 1;
        tx.set(ref, { uid, date: dateKey, scansUsed: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { incremented: true, count: next };
      });
    },
  };
}

export interface ScanQuotaDeps {
  store: ScanQuotaStore;
  getEntitlement: (uid: string) => Promise<Entitlement>;
  /** Clock, injected for testability (e.g. simulating "the next UTC day"). Defaults to the real current time. */
  now: () => Date;
}

const defaultDeps: ScanQuotaDeps = {
  store: createFirestoreScanQuotaStore(),
  getEntitlement: getUserEntitlement,
  now: () => new Date(),
};

/**
 * Checks AND consumes one scan against `uid`'s daily quota in a single
 * call — this is the ONLY function app/api/meals/analyze/route.ts calls
 * to decide whether to proceed, and it is called (and awaited) BEFORE
 * `getVisionProvider()`/`runAnalyzePipeline()` are ever invoked, so an
 * exhausted or entitlement-denied request never reaches the AI provider
 * or USDA.
 *
 * `uid` MUST be the verified uid from `withAuth` (see lib/auth.ts) —
 * never anything read from the request body. Nothing in this function's
 * signature accepts a client-claimed tier/isPro flag; entitlement is
 * always re-derived server-side via `getUserEntitlement`, so a request
 * body cannot influence the outcome no matter what extra fields it
 * contains (and the request schema doesn't even parse such fields — see
 * lib/validation.ts's analyzeMealRequestSchema).
 *
 * ---------------------------------------------------------------------
 * POLICY: when is a scan consumed, and what happens if AI/USDA later fails
 * ---------------------------------------------------------------------
 * A scan is consumed here — atomically, via `ScanQuotaStore.
 * incrementIfUnder` — for every call that reaches this function with a
 * 'free' entitlement, REGARDLESS of what happens afterward in the caller.
 * In practice (see the route), that means:
 *
 *   - A request rejected BEFORE this point (failed auth, invalid body,
 *     oversized image) never touches the counter — quota is never
 *     unfairly spent on work that was never going to reach the AI.
 *   - A request rejected BY this function (quota already exhausted)
 *     obviously doesn't consume a scan either — `incremented: false`
 *     from the store means nothing was written.
 *   - Once this returns `allowed: true`, the scan IS counted as used —
 *     even if the AI vision call or the USDA lookup that follows
 *     subsequently fails (network error, provider outage, malformed
 *     response, no confident nutrition match, etc.). There is NO refund.
 *
 * Why no refund on a downstream AI/USDA failure (deliberate V1
 * trade-off): the check-and-consume step is a single atomic operation,
 * which is what makes it trivially safe against concurrent requests (see
 * the module doc comment's CONCURRENCY section). Refunding after a later
 * failure would require a SECOND, separate write, after the fact, which
 * is not atomic with anything else that might be happening concurrently
 * for the same user (e.g. what should happen if a refund and a fresh
 * concurrent consume interleave?) — that reopens exactly the kind of
 * race/edge-case surface this design otherwise avoids, for a benefit
 * (fairness on a rare failure) that's smaller than the risk. A downstream
 * AI/USDA failure is uncommon (provider outage, transient network
 * failure) and, unlike a race condition, is not an abuse vector, so V1
 * accepts the rare fairness cost rather than the complexity of a
 * non-atomic refund. A V2 refinement, if this proves to be a real user
 * complaint, could use an idempotent refund keyed by a per-request id —
 * not implemented here.
 */
export async function consumeScanIfAllowed(uid: string, deps: ScanQuotaDeps = defaultDeps): Promise<ScanQuotaStatus> {
  const entitlement = await deps.getEntitlement(uid);

  if (entitlement === 'pro') {
    // Pro is unlimited and deliberately never touches the quota store —
    // no per-day doc is read or written for a Pro uid, so this bypass is
    // total and doesn't depend on, or interact with, the free-tier
    // counter logic below.
    return { allowed: true, entitlement: 'pro', scansUsedToday: null, scansRemainingToday: null, dailyScanLimit: null };
  }

  const dateKey = getUsageDateKeyUTC(deps.now());
  const { incremented, count } = await deps.store.incrementIfUnder(uid, dateKey, DAILY_FREE_SCAN_LIMIT);

  if (!incremented) {
    return {
      allowed: false,
      entitlement: 'free',
      scansUsedToday: count,
      scansRemainingToday: 0,
      dailyScanLimit: DAILY_FREE_SCAN_LIMIT,
      reason: `You've used all ${DAILY_FREE_SCAN_LIMIT} free scans for today. Upgrade to CalHow Pro for unlimited scans, or come back tomorrow.`,
    };
  }

  return {
    allowed: true,
    entitlement: 'free',
    scansUsedToday: count,
    scansRemainingToday: Math.max(0, DAILY_FREE_SCAN_LIMIT - count),
    dailyScanLimit: DAILY_FREE_SCAN_LIMIT,
  };
}
