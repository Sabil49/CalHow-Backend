import { describe, expect, it, vi } from 'vitest';
import { CALHOW_PRO_ENTITLEMENT_ID, getUserEntitlement, type EntitlementDeps } from '../entitlement';
import type { RevenueCatCustomer } from '../revenueCatClient';

function makeDeps(overrides: Partial<EntitlementDeps> = {}): EntitlementDeps {
  return {
    fetchActiveEntitlements: async () => null,
    ...overrides,
  };
}

describe('getUserEntitlement', () => {
  it('no entitlements at all (RevenueCat has never seen this uid) → free', async () => {
    const deps = makeDeps({ fetchActiveEntitlements: async () => null });
    expect(await getUserEntitlement('uid-1', deps)).toBe('free');
  });

  it('customer exists but has no active entitlements → free', async () => {
    const deps = makeDeps({ fetchActiveEntitlements: async () => ({ activeEntitlementIds: [] }) });
    expect(await getUserEntitlement('uid-1', deps)).toBe('free');
  });

  it('customer has an unrelated active entitlement, not calhow_pro → free', async () => {
    const customer: RevenueCatCustomer = { activeEntitlementIds: ['some_other_entitlement'] };
    const deps = makeDeps({ fetchActiveEntitlements: async () => customer });
    expect(await getUserEntitlement('uid-1', deps)).toBe('free');
  });

  it('active calhow_pro entitlement → pro', async () => {
    const customer: RevenueCatCustomer = { activeEntitlementIds: [CALHOW_PRO_ENTITLEMENT_ID] };
    const deps = makeDeps({ fetchActiveEntitlements: async () => customer });
    expect(await getUserEntitlement('uid-1', deps)).toBe('pro');
  });

  it('calhow_pro alongside other active entitlements → pro', async () => {
    const customer: RevenueCatCustomer = { activeEntitlementIds: ['some_other_entitlement', CALHOW_PRO_ENTITLEMENT_ID] };
    const deps = makeDeps({ fetchActiveEntitlements: async () => customer });
    expect(await getUserEntitlement('uid-1', deps)).toBe('pro');
  });

  it('RevenueCat API error (network failure, outage, malformed response) fails CLOSED to free, never throws', async () => {
    const deps = makeDeps({
      fetchActiveEntitlements: async () => {
        throw new Error('RevenueCat is down');
      },
    });
    await expect(getUserEntitlement('uid-1', deps)).resolves.toBe('free');
  });

  it('client cannot forge Pro status — the only input is uid; entitlement always comes from the injected fetchActiveEntitlements call, never a caller-supplied flag', async () => {
    const fetchActiveEntitlements = vi.fn(async (uid: string) => {
      expect(uid).toBe('uid-real-caller');
      return null; // RevenueCat has no record — this uid has never actually purchased anything
    });
    const deps = makeDeps({ fetchActiveEntitlements });

    const result = await getUserEntitlement('uid-real-caller', deps);

    expect(result).toBe('free');
    expect(fetchActiveEntitlements).toHaveBeenCalledTimes(1);
    expect(fetchActiveEntitlements).toHaveBeenCalledWith('uid-real-caller');
  });

  it('uses the real fetchRevenueCatActiveEntitlements as the default dep (production wiring) when no deps are injected', async () => {
    // Just verifies the function is callable with its default deps and
    // handles a real (mocked-at-fetch-level) failure gracefully — the
    // module-level default wiring itself, not the decision logic (already
    // covered above with injected deps).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(getUserEntitlement('uid-1')).resolves.toBe('free');
    vi.unstubAllGlobals();
  });
});
