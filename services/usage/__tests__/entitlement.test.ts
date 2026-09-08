import { describe, expect, it, vi } from 'vitest';
import { CALHOW_PRO_ENTITLEMENT_ID, getUserEntitlement, type EntitlementDeps } from '../entitlement';
import type { RevenueCatSubscriber } from '../revenueCatClient';

const NOW = new Date('2026-09-05T12:00:00.000Z');

function makeDeps(overrides: Partial<EntitlementDeps> = {}): EntitlementDeps {
  return {
    fetchSubscriber: async () => null,
    now: () => NOW,
    ...overrides,
  };
}

describe('getUserEntitlement', () => {
  it('no entitlement at all (RevenueCat has never seen this uid) → free', async () => {
    const deps = makeDeps({ fetchSubscriber: async () => null });
    expect(await getUserEntitlement('uid-1', deps)).toBe('free');
  });

  it('subscriber exists but has no calhow_pro entitlement entry → free', async () => {
    const deps = makeDeps({ fetchSubscriber: async () => ({ entitlements: {} }) });
    expect(await getUserEntitlement('uid-1', deps)).toBe('free');
  });

  it('subscriber has an unrelated entitlement, not calhow_pro → free', async () => {
    const subscriber: RevenueCatSubscriber = { entitlements: { some_other_entitlement: { expires_date: null } } };
    const deps = makeDeps({ fetchSubscriber: async () => subscriber });
    expect(await getUserEntitlement('uid-1', deps)).toBe('free');
  });

  it('active calhow_pro (non-expiring / lifetime grant, expires_date: null) → pro', async () => {
    const subscriber: RevenueCatSubscriber = { entitlements: { [CALHOW_PRO_ENTITLEMENT_ID]: { expires_date: null } } };
    const deps = makeDeps({ fetchSubscriber: async () => subscriber });
    expect(await getUserEntitlement('uid-1', deps)).toBe('pro');
  });

  it('active calhow_pro with a future expires_date → pro', async () => {
    const subscriber: RevenueCatSubscriber = {
      entitlements: { [CALHOW_PRO_ENTITLEMENT_ID]: { expires_date: '2026-10-01T00:00:00.000Z' } },
    };
    const deps = makeDeps({ fetchSubscriber: async () => subscriber });
    expect(await getUserEntitlement('uid-1', deps)).toBe('pro');
  });

  it('expired calhow_pro (expires_date in the past, no grace period) → free', async () => {
    const subscriber: RevenueCatSubscriber = {
      entitlements: { [CALHOW_PRO_ENTITLEMENT_ID]: { expires_date: '2026-08-01T00:00:00.000Z' } },
    };
    const deps = makeDeps({ fetchSubscriber: async () => subscriber });
    expect(await getUserEntitlement('uid-1', deps)).toBe('free');
  });

  it('cancelled subscription still active until its expiry date → pro (cancellation just means it will not auto-renew, expires_date is unchanged until then)', async () => {
    // RevenueCat does not report "cancelled" as a separate boolean here —
    // a cancelled subscriber still has a normal future expires_date up
    // until the current paid period actually ends.
    const subscriber: RevenueCatSubscriber = {
      entitlements: { [CALHOW_PRO_ENTITLEMENT_ID]: { expires_date: '2026-09-20T00:00:00.000Z', product_identifier: 'calhow_pro_monthly' } },
    };
    const deps = makeDeps({ fetchSubscriber: async () => subscriber });
    expect(await getUserEntitlement('uid-1', deps)).toBe('pro');
  });

  it('expired but within the billing-retry grace period → pro', async () => {
    const subscriber: RevenueCatSubscriber = {
      entitlements: {
        [CALHOW_PRO_ENTITLEMENT_ID]: {
          expires_date: '2026-09-01T00:00:00.000Z', // already past NOW
          grace_period_expires_date: '2026-09-10T00:00:00.000Z', // still in the future
        },
      },
    };
    const deps = makeDeps({ fetchSubscriber: async () => subscriber });
    expect(await getUserEntitlement('uid-1', deps)).toBe('pro');
  });

  it('expired and the grace period has also passed → free', async () => {
    const subscriber: RevenueCatSubscriber = {
      entitlements: {
        [CALHOW_PRO_ENTITLEMENT_ID]: {
          expires_date: '2026-08-01T00:00:00.000Z',
          grace_period_expires_date: '2026-08-05T00:00:00.000Z',
        },
      },
    };
    const deps = makeDeps({ fetchSubscriber: async () => subscriber });
    expect(await getUserEntitlement('uid-1', deps)).toBe('free');
  });

  it('RevenueCat API error (network failure, outage, malformed response) fails CLOSED to free, never throws', async () => {
    const deps = makeDeps({
      fetchSubscriber: async () => {
        throw new Error('RevenueCat is down');
      },
    });
    await expect(getUserEntitlement('uid-1', deps)).resolves.toBe('free');
  });

  it('client cannot forge Pro status — the only input is uid; entitlement always comes from the injected fetchSubscriber call, never a caller-supplied flag', async () => {
    const fetchSubscriber = vi.fn(async (uid: string) => {
      expect(uid).toBe('uid-real-caller');
      return null; // RevenueCat has no record — this uid has never actually purchased anything
    });
    const deps = makeDeps({ fetchSubscriber });

    const result = await getUserEntitlement('uid-real-caller', deps);

    expect(result).toBe('free');
    expect(fetchSubscriber).toHaveBeenCalledTimes(1);
    expect(fetchSubscriber).toHaveBeenCalledWith('uid-real-caller');
  });

  it('uses the real fetchRevenueCatSubscriber + current time as defaults when no deps are injected (production wiring)', async () => {
    // Just verifies the function is callable with its default deps and
    // handles a real (mocked-at-fetch-level) failure gracefully — the
    // module-level default wiring itself, not the decision logic (already
    // covered above with injected deps).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(getUserEntitlement('uid-1')).resolves.toBe('free');
    vi.unstubAllGlobals();
  });
});
