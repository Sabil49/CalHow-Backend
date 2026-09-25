import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicVisionProvider } from '../anthropicVisionProvider';
import { ApiRouteError } from '@/lib/apiResponse';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createAnthropicVisionProvider', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    vi.stubEnv('ANTHROPIC_VISION_MODEL', 'test-model');
    vi.stubEnv('ANTHROPIC_REQUEST_TIMEOUT_MS', '5000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('extracts and validates the tool_use block from a successful response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [
          {
            type: 'tool_use',
            name: 'report_food_detections',
            input: { foods: [{ name: 'avocado', portionGrams: 100, confidence: 0.9 }], overallConfidence: 0.9 },
          },
        ],
      }),
    );

    const provider = createAnthropicVisionProvider({ fetchFn });
    const result = await provider.analyzeMealImage({ imageBase64: 'irrelevant-for-this-test', mimeType: 'image/jpeg' });

    expect(result.detectedFoods).toHaveLength(1);
    expect(result.detectedFoods[0].rawName).toBe('avocado');
    expect(result.modelVersion).toBe('test-model');
  });

  it('never includes the request image data in the outgoing request logs/errors (sanity check on request body shape)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ content: [{ type: 'tool_use', name: 'report_food_detections', input: { foods: [], overallConfidence: 1 } }] }),
    );
    const provider = createAnthropicVisionProvider({ fetchFn });
    await provider.analyzeMealImage({ imageBase64: 'super-secret-image-bytes', mimeType: 'image/jpeg' });

    const [, requestInit] = fetchFn.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body as string);
    // The image legitimately appears once, inside the request body sent
    // TO Anthropic — this just confirms it's exactly there and nowhere
    // duplicated into headers or elsewhere unexpected.
    expect(sentBody.messages[0].content[0].source.data).toBe('super-secret-image-bytes');
    expect(JSON.stringify(requestInit.headers)).not.toContain('super-secret-image-bytes');
  });

  it('throws ai_provider_error when no tool_use block is present (model responded with plain text instead)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'I see a salad.' }] }));
    const provider = createAnthropicVisionProvider({ fetchFn });

    await expect(provider.analyzeMealImage({ imageBase64: 'x', mimeType: 'image/jpeg' })).rejects.toThrowError(ApiRouteError);
  });

  it('throws ai_provider_error on a non-2xx response, without leaking the image in the error message', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
    const provider = createAnthropicVisionProvider({ fetchFn });

    try {
      await provider.analyzeMealImage({ imageBase64: 'super-secret-image-bytes', mimeType: 'image/jpeg' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRouteError);
      expect((err as ApiRouteError).code).toBe('ai_provider_error');
      expect((err as Error).message).not.toContain('super-secret-image-bytes');
    }
  });

  it('throws ai_provider_error when the request errors/aborts (network failure)', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    const provider = createAnthropicVisionProvider({ fetchFn });

    await expect(provider.analyzeMealImage({ imageBase64: 'x', mimeType: 'image/jpeg' })).rejects.toThrowError(ApiRouteError);
  });

  it('propagates a malformed tool input as ai_provider_error via the shared schema validator', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [{ type: 'tool_use', name: 'report_food_detections', input: { foods: [{ name: 'chicken' }] } }], // missing required fields
      }),
    );
    const provider = createAnthropicVisionProvider({ fetchFn });

    await expect(provider.analyzeMealImage({ imageBase64: 'x', mimeType: 'image/jpeg' })).rejects.toThrowError(ApiRouteError);
  });
});
