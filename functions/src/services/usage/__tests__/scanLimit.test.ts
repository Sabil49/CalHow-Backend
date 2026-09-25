import { describe, expect, it, vi } from 'vitest';
import { consumeScanIfAllowed, DAILY_FREE_SCAN_LIMIT, getUsageDateKeyUTC, refundScan, type ScanQuotaDeps, type ScanQuotaStore } from '../scanLimit';
import type { Entitlement } from '../entitlement';

/**
 * In-memory ScanQuotaStore fake. `incrementIfUnder` is serialized through
 * a single promise queue per instance, so — like a real Firestore
 * transaction — "read current count" and "increment if under the limit"
 * happen as one atomic step from the caller's perspective, even when
 * multiple calls are fired concurrently (Promise.all). This is what makes
 * the concurrency test below meaningful: it proves consumeScanIfAllowed
 * calls the atomic primitive correctly under concurrent load, given a
 * store that actually honors the atomicity contract real Firestore
 * transactions provide.
 */
function createInMemoryScanQuotaStore(): ScanQuotaStore & { raw: Map<string, number> } {
  const counts = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();
  const key = (uid: string, dateKey: string) => `${uid}::${dateKey}`;

  return {
    raw: counts,
    incrementIfUnder(uid, dateKey, limit) {
      const result = queue.then(() => {
        const k = key(uid, dateKey);
        const current = counts.get(k) ?? 0;
        if (current >= limit) return { incremented: false, count: current };
        const next = current + 1;
        counts.set(k, next);
        return { incremented: true, count: next };
      });
      queue = result.catch(() => undefined);
      return result;
    },
    decrement(uid, dateKey) {
      const result = queue.then(() => {
        const k = key(uid, dateKey);
        counts.set(k, Math.max(0, (counts.get(k) ?? 0) - 1));
      });
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

function makeDeps(overrides: Partial<ScanQuotaDeps> = {}): ScanQuotaDeps {
  return {
    store: createInMemoryScanQuotaStore(),
    getEntitlement: async () => 'free',
    now: () => new Date('2026-09-05T12:00:00.000Z'),
    ...overrides,
  };
}

describe('DAILY_FREE_SCAN_LIMIT', () => {
  it('is 3, the V1 public free-tier limit', () => {
    expect(DAILY_FREE_SCAN_LIMIT).toBe(3);
  });
});

describe('getUsageDateKeyUTC', () => {
  it('produces a UTC calendar-day key regardless of local offset embedded in the Date', () => {
    expect(getUsageDateKeyUTC(new Date('2026-09-05T00:00:00.000Z'))).toBe('2026-09-05');
    expect(getUsageDateKeyUTC(new Date('2026-09-05T23:59:59.999Z'))).toBe('2026-09-05');
  });

  it('rolls over exactly at UTC midnight', () => {
    expect(getUsageDateKeyUTC(new Date('2026-09-05T23:59:59.999Z'))).toBe('2026-09-05');
    expect(getUsageDateKeyUTC(new Date('2026-09-06T00:00:00.000Z'))).toBe('2026-09-06');
  });
});

describe('consumeScanIfAllowed — free-tier daily limit', () => {
  // Written against DAILY_FREE_SCAN_LIMIT rather than a hardcoded count so
  // this doesn't silently go stale (or start asserting the wrong thing)
  // the next time that constant changes.
  it('every scan up to the limit is allowed, with correctly decrementing remaining count', async () => {
    const deps = makeDeps();
    for (let i = 1; i <= DAILY_FREE_SCAN_LIMIT; i++) {
      const result = await consumeScanIfAllowed('uid-1', deps);
      expect(result.allowed).toBe(true);
      expect(result.scansUsedToday).toBe(i);
      expect(result.scansRemainingToday).toBe(DAILY_FREE_SCAN_LIMIT - i);
      expect(result.dailyScanLimit).toBe(DAILY_FREE_SCAN_LIMIT);
    }
  });

  it('the scan right after the limit is rejected, with a scan_limit-appropriate reason and zero remaining', async () => {
    const deps = makeDeps();
    for (let i = 0; i < DAILY_FREE_SCAN_LIMIT; i++) await consumeScanIfAllowed('uid-1', deps);
    const result = await consumeScanIfAllowed('uid-1', deps);

    expect(result.allowed).toBe(false);
    expect(result.scansUsedToday).toBe(DAILY_FREE_SCAN_LIMIT);
    expect(result.scansRemainingToday).toBe(0);
    expect(result.dailyScanLimit).toBe(DAILY_FREE_SCAN_LIMIT);
    expect(result.reason).toBeTruthy();
  });

  it('further attempts keep being rejected without ever incrementing past the limit', async () => {
    const deps = makeDeps();
    for (let i = 0; i < DAILY_FREE_SCAN_LIMIT; i++) await consumeScanIfAllowed('uid-1', deps);
    for (let i = 0; i < 5; i++) {
      const result = await consumeScanIfAllowed('uid-1', deps);
      expect(result.allowed).toBe(false);
      expect(result.scansUsedToday).toBe(DAILY_FREE_SCAN_LIMIT);
    }
  });

  it('tracks separate users independently', async () => {
    const deps = makeDeps();
    for (let i = 0; i < DAILY_FREE_SCAN_LIMIT; i++) await consumeScanIfAllowed('uid-alice', deps);
    const aliceOverLimit = await consumeScanIfAllowed('uid-alice', deps);
    const bobFirst = await consumeScanIfAllowed('uid-bob', deps);

    expect(aliceOverLimit.allowed).toBe(false);
    expect(bobFirst.allowed).toBe(true);
    expect(bobFirst.scansUsedToday).toBe(1);
  });
});

describe('consumeScanIfAllowed — next UTC day resets the quota', () => {
  it('a user exhausted on one UTC day is allowed again on the next UTC day', async () => {
    const store = createInMemoryScanQuotaStore();
    const day1 = () => new Date('2026-09-05T23:00:00.000Z');
    const day2 = () => new Date('2026-09-06T01:00:00.000Z');

    const day1Deps = makeDeps({ store, now: day1 });
    for (let i = 0; i < DAILY_FREE_SCAN_LIMIT; i++) await consumeScanIfAllowed('uid-1', day1Deps);
    const exhausted = await consumeScanIfAllowed('uid-1', day1Deps);
    expect(exhausted.allowed).toBe(false);

    const day2Deps = makeDeps({ store, now: day2 });
    const freshResult = await consumeScanIfAllowed('uid-1', day2Deps);
    expect(freshResult.allowed).toBe(true);
    expect(freshResult.scansUsedToday).toBe(1);
    expect(freshResult.scansRemainingToday).toBe(DAILY_FREE_SCAN_LIMIT - 1);
  });
});

describe('consumeScanIfAllowed — concurrency safety', () => {
  it('concurrent requests beyond the limit for a fresh free user consume exactly the limit, never more', async () => {
    const deps = makeDeps();
    // Deliberately more requests than the limit (not a fixed 10 — that
    // would stop exercising the denial path at all once the limit itself
    // reaches 10, as it did for the beta bump) so this always covers both
    // the allowed and denied outcomes regardless of the limit's value.
    const requestCount = DAILY_FREE_SCAN_LIMIT + 5;
    const results = await Promise.all(Array.from({ length: requestCount }, () => consumeScanIfAllowed('uid-1', deps)));

    const allowedCount = results.filter((r) => r.allowed).length;
    const deniedCount = results.filter((r) => !r.allowed).length;
    expect(allowedCount).toBe(DAILY_FREE_SCAN_LIMIT);
    expect(deniedCount).toBe(requestCount - DAILY_FREE_SCAN_LIMIT);

    // No result ever reports a used-count beyond the limit.
    for (const r of results) {
      expect(r.scansUsedToday).toBeLessThanOrEqual(DAILY_FREE_SCAN_LIMIT);
    }
  });

  it('a user with exactly one scan remaining cannot be pushed over the limit by two simultaneous requests', async () => {
    const deps = makeDeps();
    for (let i = 0; i < DAILY_FREE_SCAN_LIMIT - 1; i++) await consumeScanIfAllowed('uid-1', deps); // 1 remaining

    const [a, b] = await Promise.all([consumeScanIfAllowed('uid-1', deps), consumeScanIfAllowed('uid-1', deps)]);
    const allowedResults = [a, b].filter((r) => r.allowed);
    expect(allowedResults).toHaveLength(1);
    expect(allowedResults[0]!.scansUsedToday).toBe(DAILY_FREE_SCAN_LIMIT);
  });
});

describe('consumeScanIfAllowed — entitlement boundary', () => {
  it('a "pro" entitlement bypasses the free quota cleanly and never touches the quota store', async () => {
    const store = createInMemoryScanQuotaStore();
    const deps = makeDeps({ store, getEntitlement: async () => 'pro' as Entitlement });

    const result = await consumeScanIfAllowed('uid-1', deps);

    expect(result.allowed).toBe(true);
    expect(result.entitlement).toBe('pro');
    expect(result.dailyScanLimit).toBeNull();
    expect(result.scansRemainingToday).toBeNull();
    // The store was never written to for this uid — Pro doesn't consume
    // or track against the free-tier counter at all.
    expect(store.raw.size).toBe(0);
  });

  it('a "pro" entitlement is unlimited even after what would exhaust a free user', async () => {
    const deps = makeDeps({ getEntitlement: async () => 'pro' as Entitlement });
    for (let i = 0; i < DAILY_FREE_SCAN_LIMIT + 5; i++) {
      const result = await consumeScanIfAllowed('uid-1', deps);
      expect(result.allowed).toBe(true);
    }
  });

  it('client cannot influence entitlement — consumeScanIfAllowed only ever asks the injected server-side getEntitlement, keyed by uid alone', async () => {
    // There is no isPro/tier parameter anywhere in this function's
    // signature; entitlement can only come from the deps.getEntitlement
    // call, which in production is services/usage/entitlement.ts's
    // getUserEntitlement — a function that itself only accepts a uid (see
    // entitlement.test.ts). This test documents that consumeScanIfAllowed
    // enforces whatever that call returns and nothing else, by using a
    // fake that would reveal it if the uid were somehow miscommunicated.
    let receivedUid: string | undefined;
    const deps = makeDeps({
      getEntitlement: async (uid) => {
        receivedUid = uid;
        return 'free';
      },
    });
    await consumeScanIfAllowed('uid-real-caller', deps);
    expect(receivedUid).toBe('uid-real-caller');
  });

  describe('refundScan', () => {
    it('gives a failed free scan back so it no longer counts against the day', async () => {
      const deps = makeDeps();
      for (let i = 0; i < DAILY_FREE_SCAN_LIMIT; i++) {
        const status = await consumeScanIfAllowed('uid-1', deps);
        await refundScan('uid-1', status, deps);
      }
      const next = await consumeScanIfAllowed('uid-1', deps);
      expect(next.allowed).toBe(true);
      expect(next.scansUsedToday).toBe(1);
    });

    it('is a no-op for Pro and for denied requests (nothing was consumed)', async () => {
      const store = createInMemoryScanQuotaStore();
      const proStatus = await consumeScanIfAllowed('uid-pro', makeDeps({ store, getEntitlement: async () => 'pro' }));
      await refundScan('uid-pro', proStatus, { store });
      expect(store.raw.size).toBe(0);

      const freeDeps = makeDeps({ store });
      for (let i = 0; i < DAILY_FREE_SCAN_LIMIT; i++) await consumeScanIfAllowed('uid-1', freeDeps);
      const denied = await consumeScanIfAllowed('uid-1', freeDeps);
      await refundScan('uid-1', denied, { store });
      expect([...store.raw.values()]).toEqual([DAILY_FREE_SCAN_LIMIT]);
    });

    it('never throws, even if the store fails', async () => {
      const status = await consumeScanIfAllowed('uid-1', makeDeps());
      const failingStore = { incrementIfUnder: vi.fn(), decrement: vi.fn().mockRejectedValue(new Error('firestore down')) };
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(refundScan('uid-1', status, { store: failingStore })).resolves.toBeUndefined();
      errSpy.mockRestore();
    });
  });
});
