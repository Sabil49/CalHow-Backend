import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRevenueCatActiveEntitlements, RevenueCatApiError } from '../revenueCatClient';

vi.mock('@/lib/env', () => ({
  getRevenueCatEnv: () => ({ REVENUECAT_SECRET_API_KEY: 'sk_test_secret', REVENUECAT_PROJECT_ID: 'proj_test' }),
}));

function makeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(response: Response) {
  return vi.fn().mockResolvedValue(response);
}

describe('fetchRevenueCatActiveEntitlements', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests GET /v2/projects/{project_id}/customers/{customer_id}/active_entitlements with the server-only secret as a Bearer token', async () => {
    vi.stubGlobal('fetch', stubFetch(makeResponse(200, { items: [] })));

    await fetchRevenueCatActiveEntitlements('uid-1');

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.revenuecat.com/v2/projects/proj_test/customers/uid-1/active_entitlements');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_secret');
  });

  it('URL-encodes the customer id', async () => {
    vi.stubGlobal('fetch', stubFetch(makeResponse(200, { items: [] })));

    await fetchRevenueCatActiveEntitlements('uid with spaces/slash');

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.revenuecat.com/v2/projects/proj_test/customers/${encodeURIComponent('uid with spaces/slash')}/active_entitlements`,
    );
  });

  it('returns null on 404 (no RevenueCat customer record yet) rather than throwing', async () => {
    vi.stubGlobal('fetch', stubFetch(makeResponse(404, { message: 'not found' })));

    const result = await fetchRevenueCatActiveEntitlements('never-seen-uid');
    expect(result).toBeNull();
  });

  it('returns the active entitlement ids on 200', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(makeResponse(200, { items: [{ object: 'customer.active_entitlement', entitlement_id: 'calhow_pro', expires_at: null }] })),
    );

    const result = await fetchRevenueCatActiveEntitlements('uid-1');
    expect(result).toEqual({ activeEntitlementIds: ['calhow_pro'] });
  });

  it('returns an empty list when the customer has no active entitlements', async () => {
    vi.stubGlobal('fetch', stubFetch(makeResponse(200, { items: [] })));

    const result = await fetchRevenueCatActiveEntitlements('uid-1');
    expect(result).toEqual({ activeEntitlementIds: [] });
  });

  it('throws RevenueCatApiError on a non-404 non-2xx response', async () => {
    vi.stubGlobal('fetch', stubFetch(makeResponse(401, { message: 'invalid api key' })));

    await expect(fetchRevenueCatActiveEntitlements('uid-1')).rejects.toThrow(RevenueCatApiError);
  });

  it('throws RevenueCatApiError on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(fetchRevenueCatActiveEntitlements('uid-1')).rejects.toThrow(RevenueCatApiError);
  });

  it('throws RevenueCatApiError on a malformed (non-JSON) 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'not json',
        json: async () => {
          throw new Error('Unexpected token');
        },
      } as unknown as Response),
    );

    await expect(fetchRevenueCatActiveEntitlements('uid-1')).rejects.toThrow(RevenueCatApiError);
  });
});
