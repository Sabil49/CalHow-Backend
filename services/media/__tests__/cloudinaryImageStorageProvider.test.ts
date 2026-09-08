import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudinaryImageStorageProvider } from '../cloudinaryImageStorageProvider';
import { ApiRouteError } from '@/lib/apiResponse';

vi.mock('@/lib/env', () => ({
  getCloudinaryEnv: () => ({
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-api-key',
    CLOUDINARY_API_SECRET: 'test-api-secret',
  }),
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

describe('CloudinaryImageStorageProvider', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      stubFetch(
        makeResponse(200, {
          secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/calhow/users/uid-1/meals/analysis-1.jpg',
          public_id: 'calhow/users/uid-1/meals/analysis-1',
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('local image → durable URL', () => {
    it('uploads to Cloudinary and returns a durable https URL, never the local input echoed back', async () => {
      const provider = createCloudinaryImageStorageProvider();
      const result = await provider.upload({ imageBase64: 'ZmFrZS1pbWFnZS1ieXRlcw==', mimeType: 'image/jpeg', uid: 'uid-1', imageId: 'analysis-1' });

      expect(result.url).toBe('https://res.cloudinary.com/test-cloud/image/upload/v1/calhow/users/uid-1/meals/analysis-1.jpg');
      expect(result.url).not.toContain('file://');
      expect(result.url.startsWith('https://')).toBe(true);
    });

    it('POSTs to Cloudinary using HTTP Basic Auth built from the server-only API key/secret', async () => {
      const provider = createCloudinaryImageStorageProvider();
      await provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/png', uid: 'uid-1', imageId: 'analysis-1' });

      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.cloudinary.com/v1_1/test-cloud/image/upload');
      expect(init.method).toBe('POST');
      const authHeader = (init.headers as Record<string, string>).Authorization;
      expect(authHeader).toBe(`Basic ${Buffer.from('test-api-key:test-api-secret').toString('base64')}`);
    });

    it('sends the image as a base64 data URI in the file field, never as a client-supplied URL', async () => {
      const provider = createCloudinaryImageStorageProvider();
      await provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/png', uid: 'uid-1', imageId: 'analysis-1' });

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const form = init.body as FormData;
      expect(form.get('file')).toBe('data:image/png;base64,ZmFrZQ==');
    });
  });

  describe('upload failure', () => {
    it('throws ApiRouteError("image_upload_error") on a non-2xx response, never returning a fabricated URL', async () => {
      vi.stubGlobal('fetch', stubFetch(makeResponse(401, { error: { message: 'Invalid Signature' } })));
      const provider = createCloudinaryImageStorageProvider();

      await expect(
        provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid-1', imageId: 'analysis-1' }),
      ).rejects.toThrow(ApiRouteError);
      await expect(
        provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid-1', imageId: 'analysis-1' }),
      ).rejects.toMatchObject({ code: 'image_upload_error' });
    });

    it('throws ApiRouteError("image_upload_error") on a network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const provider = createCloudinaryImageStorageProvider();

      await expect(
        provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid-1', imageId: 'analysis-1' }),
      ).rejects.toMatchObject({ code: 'image_upload_error' });
    });

    it('throws ApiRouteError("image_upload_error") when Cloudinary returns 200 with no secure_url, rather than fabricating one', async () => {
      vi.stubGlobal('fetch', stubFetch(makeResponse(200, { public_id: 'calhow/users/uid-1/meals/analysis-1' })));
      const provider = createCloudinaryImageStorageProvider();

      await expect(
        provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid-1', imageId: 'analysis-1' }),
      ).rejects.toMatchObject({ code: 'image_upload_error' });
    });
  });

  describe('authenticated ownership / user-scoping', () => {
    it('builds the path as calhow/users/{uid}/meals/{imageId}, from the caller’s own verified uid, never a client-supplied uid', async () => {
      const provider = createCloudinaryImageStorageProvider();
      await provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid-alice', imageId: 'analysis-42' });

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const form = init.body as FormData;
      expect(form.get('public_id')).toBe('calhow/users/uid-alice/meals/analysis-42');
    });

    it('never lets two different users share the same destination path, even with the same imageId', async () => {
      const provider = createCloudinaryImageStorageProvider();
      await provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid-alice', imageId: 'analysis-1' });
      const [, aliceInit] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const alicePublicId = (aliceInit.body as FormData).get('public_id') as string;

      await provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid-bob', imageId: 'analysis-1' });
      const [, bobInit] = (fetch as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit];
      const bobPublicId = (bobInit.body as FormData).get('public_id') as string;

      expect(alicePublicId).not.toBe(bobPublicId);
      expect(alicePublicId).toBe('calhow/users/uid-alice/meals/analysis-1');
      expect(bobPublicId).toBe('calhow/users/uid-bob/meals/analysis-1');
    });

    it('requests overwrite:true, but that only ever means a retry of the SAME uid+analysisId can safely replace its own in-progress upload', async () => {
      const provider = createCloudinaryImageStorageProvider();
      await provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid-alice', imageId: 'analysis-1' });

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const form = init.body as FormData;
      expect(form.get('overwrite')).toBe('true');
    });

    it('is idempotent: the same uid+imageId always produces the same destination path (retry-safe)', async () => {
      const provider = createCloudinaryImageStorageProvider();
      await provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid-alice', imageId: 'analysis-1' });
      const [, firstInit] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const firstId = (firstInit.body as FormData).get('public_id') as string;

      await provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid-alice', imageId: 'analysis-1' });
      const [, secondInit] = (fetch as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit];
      const secondId = (secondInit.body as FormData).get('public_id') as string;

      expect(firstId).toBe(secondId);
    });

    it('sanitizes unexpected characters out of uid/imageId rather than passing them through into the Cloudinary path', async () => {
      const provider = createCloudinaryImageStorageProvider();
      await provider.upload({ imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg', uid: 'uid/../weird', imageId: 'a b/c' });

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const form = init.body as FormData;
      const publicId = form.get('public_id') as string;
      expect(publicId).toBe('calhow/users/uid____weird/meals/a_b_c');
    });
  });
});
