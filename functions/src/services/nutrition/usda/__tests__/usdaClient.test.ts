import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchUsdaFoods, searchUsdaFoodsUnfiltered, UsdaApiError } from '../usdaClient';

vi.mock('@/lib/env', () => ({
  getUsdaEnv: () => ({
    USDA_FDC_API_KEY: 'test-key-abc123',
    USDA_FDC_BASE_URL: 'https://api.nal.usda.gov/fdc/v1',
    USDA_REQUEST_TIMEOUT_MS: 8000,
  }),
}));

const SEARCH_ENDPOINT = 'https://api.nal.usda.gov/fdc/v1/foods/search';

function makeResponse(status: number, body: string, contentType = 'application/json') {
  const text = async () => body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_: string) => contentType },
    text,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

function stubFetch(response: Response) {
  return vi.fn().mockResolvedValue(response);
}

describe('usdaClient — HTTP request shape', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', stubFetch(makeResponse(200, JSON.stringify({ foods: [] }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('searchUsdaFoods', () => {
    it('uses POST', async () => {
      await searchUsdaFoods('banana');
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('POST');
    });

    it('sends to the /foods/search endpoint with api_key in the URL', async () => {
      await searchUsdaFoods('banana');
      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toContain(SEARCH_ENDPOINT);
      expect(url).toContain('api_key=');
    });

    it('does not include the API key in the request body', async () => {
      await searchUsdaFoods('banana');
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body).not.toHaveProperty('api_key');
    });

    it('body contains query', async () => {
      await searchUsdaFoods('roasted spiced cauliflower');
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.query).toBe('roasted spiced cauliflower');
    });

    it('body contains pageSize', async () => {
      await searchUsdaFoods('banana', 15);
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.pageSize).toBe(15);
    });

    it('body contains dataType as an array with all three preferred types', async () => {
      await searchUsdaFoods('banana');
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(Array.isArray(body.dataType)).toBe(true);
      expect(body.dataType).toContain('Foundation');
      expect(body.dataType).toContain('SR Legacy');
      expect(body.dataType).toContain('Survey (FNDDS)');
    });

    it('sets Content-Type: application/json', async () => {
      await searchUsdaFoods('banana');
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('throws UsdaApiError on a non-200 response', async () => {
      vi.stubGlobal('fetch', stubFetch(makeResponse(400, '<html>400 Bad Request</html>', 'text/html')));
      await expect(searchUsdaFoods('banana')).rejects.toThrow(UsdaApiError);
    });

    it('throws UsdaApiError on network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      await expect(searchUsdaFoods('banana')).rejects.toThrow(UsdaApiError);
    });

    it('returns the parsed response on success', async () => {
      const payload = { foods: [{ fdcId: 1, description: 'Banana, raw', dataType: 'Foundation' }] };
      vi.stubGlobal('fetch', stubFetch(makeResponse(200, JSON.stringify(payload))));
      const result = await searchUsdaFoods('banana');
      expect(result.foods).toHaveLength(1);
      expect(result.foods![0].description).toBe('Banana, raw');
    });
  });

  describe('searchUsdaFoodsUnfiltered', () => {
    it('uses POST', async () => {
      await searchUsdaFoodsUnfiltered('banana');
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('POST');
    });

    it('body contains query and pageSize', async () => {
      await searchUsdaFoodsUnfiltered('banana', 5);
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.query).toBe('banana');
      expect(body.pageSize).toBe(5);
    });

    it('body does not contain dataType (unfiltered by design)', async () => {
      await searchUsdaFoodsUnfiltered('banana');
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body).not.toHaveProperty('dataType');
    });

    it('does not include the API key in the request body', async () => {
      await searchUsdaFoodsUnfiltered('banana');
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body).not.toHaveProperty('api_key');
    });

    it('throws UsdaApiError on a non-200 response', async () => {
      vi.stubGlobal('fetch', stubFetch(makeResponse(400, '<html>400 Bad Request</html>', 'text/html')));
      await expect(searchUsdaFoodsUnfiltered('banana')).rejects.toThrow(UsdaApiError);
    });
  });
});
