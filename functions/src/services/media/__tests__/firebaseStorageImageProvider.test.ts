import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFirebaseStorageImageProvider } from '../firebaseStorageImageProvider';
import { ApiRouteError } from '@/lib/apiResponse';

const saveMock = vi.fn();

vi.mock('@/lib/firebaseAdmin', () => ({
  getAdminStorage: () => ({
    bucket: () => ({
      file: (objectPath: string) => ({
        bucket: { name: 'calhow-712c0.appspot.com' },
        save: (...args: unknown[]) => saveMock(objectPath, ...args),
      }),
    }),
  }),
}));

function baseParams() {
  return {
    imageBase64: Buffer.from('fake image bytes').toString('base64'),
    mimeType: 'image/jpeg' as const,
    uid: 'uid-1',
    imageId: 'analysis-1',
  };
}

describe('createFirebaseStorageImageProvider', () => {
  beforeEach(() => {
    saveMock.mockReset();
  });

  it('uploads to a deterministic, user-scoped object path', async () => {
    saveMock.mockResolvedValue(undefined);
    const provider = createFirebaseStorageImageProvider();

    await provider.upload(baseParams());

    expect(saveMock).toHaveBeenCalledWith(
      'meals/uid-1/analysis-1',
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'image/jpeg' }),
    );
  });

  it('sanitizes uid/imageId path segments', async () => {
    saveMock.mockResolvedValue(undefined);
    const provider = createFirebaseStorageImageProvider();

    await provider.upload({ ...baseParams(), uid: 'uid/with slashes', imageId: 'id/with spaces' });

    expect(saveMock).toHaveBeenCalledWith(
      'meals/uid_with_slashes/id_with_spaces',
      expect.any(Buffer),
      expect.anything(),
    );
  });

  it('sets a download token in the object metadata, and returns a matching download URL', async () => {
    saveMock.mockResolvedValue(undefined);
    const provider = createFirebaseStorageImageProvider();

    const result = await provider.upload(baseParams());

    const [, , options] = saveMock.mock.calls[0] as [string, Buffer, { metadata: { metadata: { firebaseStorageDownloadTokens: string } } }];
    const token = options.metadata.metadata.firebaseStorageDownloadTokens;
    expect(token).toBeTruthy();
    expect(result.url).toBe(
      `https://firebasestorage.googleapis.com/v0/b/calhow-712c0.appspot.com/o/${encodeURIComponent('meals/uid-1/analysis-1')}?alt=media&token=${token}`,
    );
  });

  it('returns the object path as providerId', async () => {
    saveMock.mockResolvedValue(undefined);
    const provider = createFirebaseStorageImageProvider();

    const result = await provider.upload(baseParams());

    expect(result.providerId).toBe('meals/uid-1/analysis-1');
  });

  it('throws ApiRouteError(image_upload_error) when the underlying save() call fails', async () => {
    saveMock.mockRejectedValue(new Error('bucket unavailable'));
    const provider = createFirebaseStorageImageProvider();

    await expect(provider.upload(baseParams())).rejects.toThrow(ApiRouteError);
    await expect(provider.upload(baseParams())).rejects.toMatchObject({ code: 'image_upload_error' });
  });
});
