import { getAdminFirestore, getAdminStorage } from '@/lib/firebaseAdmin';

/**
 * Removes everything the backend holds for a user, once their Firebase Auth
 * account is deleted (see the `onAccountDeleted` trigger in index.ts):
 *
 *   - meal photos in Cloud Storage (`meals/{uid}/...`, written by
 *     /uploadMealImage) — storage.rules are default-deny, so the app can't
 *     delete these itself
 *   - scan analyses still waiting to be saved (`pendingAnalyses`, keyed by
 *     a `uid` field)
 *   - users/{uid} and its subcollections — the app deletes these before
 *     deleting the account; this is a safety net for a deletion that was
 *     interrupted halfway
 *
 * Idempotent: every step is a no-op when there's nothing left to delete,
 * so a retried trigger is safe.
 */
export async function deleteBackendUserData(uid: string): Promise<void> {
  if (!uid) throw new Error('deleteBackendUserData: uid is required');
  const db = getAdminFirestore();

  await getAdminStorage().bucket().deleteFiles({ prefix: `meals/${uid}/` });

  const pending = await db.collection('pendingAnalyses').where('uid', '==', uid).get();
  const writer = db.bulkWriter();
  for (const doc of pending.docs) void writer.delete(doc.ref);
  await writer.close();

  await db.recursiveDelete(db.collection('users').doc(uid));
}
