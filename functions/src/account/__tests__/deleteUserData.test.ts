import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteBackendUserData } from '../deleteUserData';

const deleteFiles = vi.fn();
const bulkDelete = vi.fn();
const bulkClose = vi.fn();
const recursiveDelete = vi.fn();
const where = vi.fn();
const pendingDocs = [{ ref: 'pending-ref-1' }, { ref: 'pending-ref-2' }];

vi.mock('@/lib/firebaseAdmin', () => ({
  getAdminStorage: () => ({ bucket: () => ({ deleteFiles }) }),
  getAdminFirestore: () => ({
    collection: (name: string) => ({
      where: (...args: unknown[]) => {
        where(name, ...args);
        return { get: async () => ({ docs: pendingDocs }) };
      },
      doc: (id: string) => `${name}/${id}`,
    }),
    bulkWriter: () => ({ delete: bulkDelete, close: bulkClose }),
    recursiveDelete,
  }),
}));

describe('deleteBackendUserData', () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the user's meal photos, pending analyses and profile tree — and only theirs", async () => {
    await deleteBackendUserData('user-1');

    expect(deleteFiles).toHaveBeenCalledWith({ prefix: 'meals/user-1/' });
    expect(where).toHaveBeenCalledWith('pendingAnalyses', 'uid', '==', 'user-1');
    expect(bulkDelete).toHaveBeenCalledTimes(2);
    expect(bulkDelete).toHaveBeenCalledWith('pending-ref-1');
    expect(bulkClose).toHaveBeenCalledTimes(1);
    expect(recursiveDelete).toHaveBeenCalledWith('users/user-1');
  });

  it('refuses an empty uid rather than deleting the whole meals/ prefix', async () => {
    await expect(deleteBackendUserData('')).rejects.toThrow();
    expect(deleteFiles).not.toHaveBeenCalled();
  });
});
