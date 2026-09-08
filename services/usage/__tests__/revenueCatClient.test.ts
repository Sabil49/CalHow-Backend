import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRevenueCatSubscriber, RevenueCatApiError } from '../revenueCatClient';

vi.mock('@/lib/env', () => ({
  getRevenueCatEnv: () => ({ REVENUECAT_SECRET_API_KEY: 'sk_test_secret' }),
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

describe('fetchRevenueCatSubscriber', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests GET /v1/subscribers/{app_user_id} with the server-only secret as a Bearer token', async () => {
    vi.stubGlobal('fetch', stubFetch(makeResponse(200, { subscriber: { entitlements: {} } })));

    await fetchRevenueCatSubscriber('uid-1');

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.revenuecat.com/v1/subscribers/uid-1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_secret');
  });

  it('URL-encodes the app_user_id', async () => {
    vi.stubGlobal('fetch', stubFetch(makeResponse(200, { subscriber: { entitlements: {} } })));

    await fetchRevenueCatSubscriber('uid with spaces/slash');

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent('uid with spaces/slash')}`);
  });

  it('returns null on 404 (no RevenueCat customer record yet) rather than throwing', async () => {
    vi.stubGlobal('fetch', stubFetch(makeResponse(404, { message: 'not found' })));

    const result = await fetchRevenueCatSubscriber('never-seen-uid');
    expect(result).toBeNull();
  });

  it('returns the parsed subscriber on 200', async () => {
    const subscriber = { entitlements: { calhow_pro: { expires_date: null } } };
    vi.stubGlobal('fetch', stubFetch(makeResponse(200, { subscriber })));

    const result = await fetchRevenueCatSubscriber('uid-1');
    expect(result).toEqual(subscriber);
  });

  it('throws RevenueCatApiError on a non-404 non-2xx response', async () => {
    vi.stubGlobal('fetch', stubFetch(makeResponse(401, { message: 'invalid api key' })));

    await expect(fetchRevenueCatSubscriber('uid-1')).rejects.toThrow(RevenueCatApiError);
  });

  it('throws RevenueCatApiError on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(fetchRevenueCatSubscriber('uid-1')).rejects.toThrow(RevenueCatApiError);
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

    await expect(fetchRevenueCatSubscriber('uid-1')).rejects.toThrow(RevenueCatApiError);
  });
});
