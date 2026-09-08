import { describe, expect, it } from 'vitest';
import { consumeScanIfAllowed, DAILY_FREE_SCAN_LIMIT, getUsageDateKeyUTC, type ScanQuotaDeps, type ScanQuotaStore } from '../scanLimit';
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
  it('is 3, per the approved V1 product rule', () => {
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
  it('scan 1 → allowed', async () => {
    const deps = makeDeps();
    const result = await consumeScanIfAllowed('uid-1', deps);
    expect(result.allowed).toBe(true);
    expect(result.scansUsedToday).toBe(1);
    expect(result.scansRemainingToday).toBe(2);
    expect(result.dailyScanLimit).toBe(3);
  });

  it('scan 2 → allowed', async () => {
    const deps = makeDeps();
    await consumeScanIfAllowed('uid-1', deps);
    const result = await consumeScanIfAllowed('uid-1', deps);
    expect(result.allowed).toBe(true);
    expect(result.scansUsedToday).toBe(2);
    expect(result.scansRemainingToday).toBe(1);
  });

  it('scan 3 → allowed', async () => {
    const deps = makeDeps();
    await consumeScanIfAllowed('uid-1', deps);
    await consumeScanIfAllowed('uid-1', deps);
    const result = await consumeScanIfAllowed('uid-1', deps);
    expect(result.allowed).toBe(true);
    expect(result.scansUsedToday).toBe(3);
    expect(result.scansRemainingToday).toBe(0);
  });

  it('scan 4 → rejected, with a scan_limit-appropriate reason and zero remaining', async () => {
    const deps = makeDeps();
    await consumeScanIfAllowed('uid-1', deps);
    await consumeScanIfAllowed('uid-1', deps);
    await consumeScanIfAllowed('uid-1', deps);
    const result = await consumeScanIfAllowed('uid-1', deps);

    expect(result.allowed).toBe(false);
    expect(result.scansUsedToday).toBe(3);
    expect(result.scansRemainingToday).toBe(0);
    expect(result.dailyScanLimit).toBe(3);
    expect(result.reason).toBeTruthy();
  });

  it('a 5th, 6th, ... attempt keeps being rejected without ever incrementing past the limit', async () => {
    const deps = makeDeps();
    for (let i = 0; i < 3; i++) await consumeScanIfAllowed('uid-1', deps);
    for (let i = 0; i < 5; i++) {
      const result = await consumeScanIfAllowed('uid-1', deps);
      expect(result.allowed).toBe(false);
      expect(result.scansUsedToday).toBe(3);
    }
  });

  it('tracks separate users independently', async () => {
    const deps = makeDeps();
    await consumeScanIfAllowed('uid-alice', deps);
    await consumeScanIfAllowed('uid-alice', deps);
    await consumeScanIfAllowed('uid-alice', deps);
    const aliceFourth = await consumeScanIfAllowed('uid-alice', deps);
    const bobFirst = await consumeScanIfAllowed('uid-bob', deps);

    expect(aliceFourth.allowed).toBe(false);
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
    await consumeScanIfAllowed('uid-1', day1Deps);
    await consumeScanIfAllowed('uid-1', day1Deps);
    await consumeScanIfAllowed('uid-1', day1Deps);
    const exhausted = await consumeScanIfAllowed('uid-1', day1Deps);
    expect(exhausted.allowed).toBe(false);

    const day2Deps = makeDeps({ store, now: day2 });
    const freshResult = await consumeScanIfAllowed('uid-1', day2Deps);
    expect(freshResult.allowed).toBe(true);
    expect(freshResult.scansUsedToday).toBe(1);
    expect(freshResult.scansRemainingToday).toBe(2);
  });
});

describe('consumeScanIfAllowed — concurrency safety', () => {
  it('10 concurrent requests for a fresh free user consume exactly 3 scans, never more', async () => {
    const deps = makeDeps();
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeScanIfAllowed('uid-1', deps)));

    const allowedCount = results.filter((r) => r.allowed).length;
    const deniedCount = results.filter((r) => !r.allowed).length;
    expect(allowedCount).toBe(DAILY_FREE_SCAN_LIMIT);
    expect(deniedCount).toBe(10 - DAILY_FREE_SCAN_LIMIT);

    // No result ever reports a used-count beyond the limit.
    for (const r of results) {
      expect(r.scansUsedToday).toBeLessThanOrEqual(DAILY_FREE_SCAN_LIMIT);
    }
  });

  it('a user with exactly one scan remaining cannot be pushed over the limit by two simultaneous requests', async () => {
    const deps = makeDeps();
    await consumeScanIfAllowed('uid-1', deps); // 1 used
    await consumeScanIfAllowed('uid-1', deps); // 2 used, 1 remaining

    const [a, b] = await Promise.all([consumeScanIfAllowed('uid-1', deps), consumeScanIfAllowed('uid-1', deps)]);
    const allowedResults = [a, b].filter((r) => r.allowed);
    expect(allowedResults).toHaveLength(1);
    expect(allowedResults[0]!.scansUsedToday).toBe(3);
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
    for (let i = 0; i < 10; i++) {
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
});
