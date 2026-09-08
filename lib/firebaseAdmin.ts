import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getFirebaseAdminEnv } from './env';

/**
 * Firebase Admin SDK initialization.
 *
 * This is the backend's ONLY privileged access point to Firebase — there
 * are no Cloud Functions in this project (Spark plan). Two important
 * consequences documented here so they're not lost:
 *
 *   1. Admin SDK credentials (a service account) are a genuine secret.
 *      They must only ever come from server-side env vars (see lib/env.ts
 *      / .env.example) and must never be logged, returned in a response,
 *      or committed to the repo.
 *
 *   2. The Admin SDK BYPASSES Firestore Security Rules entirely. The
 *      rules deployed for the mobile app's direct Firestore access
 *      (firestore.rules in the calhow repo) do nothing here — this
 *      backend is a fully trusted server context, so every ownership
 *      check (e.g. "does this analysisId belong to this uid?") must be
 *      enforced explicitly in application code. See
 *      services/analysis/analysisStore.ts.
 *
 * Initialization is lazy (functions, not top-level consts) so importing
 * this module — which happens whenever a route handler file is loaded,
 * including during `next build`'s static analysis — never requires real
 * credentials to be present. Only actually calling getAdminAuth() /
 * getAdminFirestore() at request time does.
 */

let cachedApp: App | undefined;

function getAdminApp(): App {
  if (cachedApp) return cachedApp;

  // Guards against re-initialization across Next.js dev-server hot
  // reloads, which can re-execute this module without a fresh process.
  const existing = getApps();
  if (existing.length > 0) {
    cachedApp = existing[0]!;
    return cachedApp;
  }

  const { projectId, clientEmail, privateKey } = getFirebaseAdminEnv();
  cachedApp = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
  return cachedApp;
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}

let cachedFirestore: Firestore | undefined;

export function getAdminFirestore(): Firestore {
  if (cachedFirestore) return cachedFirestore;
  const db = getFirestore(getAdminApp());
  // settings() must be called once, before any Firestore operations, and
  // throws on subsequent calls — so it is applied here at cache-fill time
  // only. ignoreUndefinedProperties makes undefined optional fields (e.g.
  // detectedFoods[].uncertaintyTopics) be omitted from the document rather
  // than throwing, matching the mobile Firestore client's behaviour.
  db.settings({ ignoreUndefinedProperties: true });
  cachedFirestore = db;
  return cachedFirestore;
}
