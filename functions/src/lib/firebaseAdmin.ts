import { getApps, initializeApp, type App } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';

/**
 * Firebase Admin SDK initialization.
 *
 * Runs as Cloud Functions in this project's own Firebase project, so
 * `initializeApp()` with no arguments uses Application Default
 * Credentials — the function's built-in runtime service account, which
 * already has Firestore/Auth/Storage access. No service-account key or
 * FIREBASE_ADMIN_* env vars needed (unlike the old Vercel-hosted Next.js
 * backend this replaced).
 *
 * Locally (scripts/, the emulator suite), ADC comes from either the
 * Firebase Emulator Suite's own fake credentials or `gcloud auth
 * application-default login` — see functions/README or scripts/*.ts for
 * per-script notes.
 *
 * The Admin SDK BYPASSES Firestore/Storage Security Rules entirely. The
 * rules deployed for the mobile app's direct Firestore/Storage access
 * (calhow-mobile/firestore.rules, storage.rules) do nothing here — every
 * ownership check (e.g. "does this analysisId belong to this uid?") must
 * be enforced explicitly in application code. See
 * services/analysis/analysisStore.ts.
 *
 * IMPORTANT — lazy `require()`, not top-level `import`, for the
 * auth/firestore/storage submodules: `firebase-admin/firestore` alone
 * pulls in `@google-cloud/firestore`, which takes ~2s to load cold; auth
 * adds another ~0.75s. `firebase deploy` runs a discovery step that
 * `require()`s this whole codebase in a subprocess with a hard 10s
 * timeout to enumerate the exported functions — it never actually calls
 * these getters, but a top-level `import` still pays the load cost just
 * by being required, which was enough on its own to blow that budget
 * ("User code failed to load ... Cannot determine backend specification.
 * Timeout after 10000"). Only `import type` here (erased at compile time,
 * so it's free) — the real modules are `require()`'d inside each getter,
 * so their cost is paid only when a function actually handles a request,
 * never during deploy-time discovery.
 */

let cachedApp: App | undefined;

function getAdminApp(): App {
  if (cachedApp) return cachedApp;

  const existing = getApps();
  if (existing.length > 0) {
    cachedApp = existing[0]!;
    return cachedApp;
  }

  cachedApp = initializeApp();
  return cachedApp;
}

export function getAdminAuth(): Auth {
  const { getAuth } = require('firebase-admin/auth') as typeof import('firebase-admin/auth');
  return getAuth(getAdminApp());
}

let cachedFirestore: Firestore | undefined;

export function getAdminFirestore(): Firestore {
  if (cachedFirestore) return cachedFirestore;
  const { getFirestore } = require('firebase-admin/firestore') as typeof import('firebase-admin/firestore');
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

export function getAdminStorage(): Storage {
  const { getStorage } = require('firebase-admin/storage') as typeof import('firebase-admin/storage');
  return getStorage(getAdminApp());
}

/**
 * Lazy access to Firestore's `Timestamp`/`FieldValue` value classes (e.g.
 * `Timestamp.now()`, `FieldValue.serverTimestamp()`) — same rationale as
 * every other lazy `require()` in this file. Callers that only need the
 * *types* (e.g. a field typed `Timestamp`) should still use `import type
 * { Timestamp } from 'firebase-admin/firestore'` directly — that's erased
 * at compile time and costs nothing; this is only for code that calls
 * these as actual runtime values.
 */
export function getFirestoreValues(): Pick<typeof import('firebase-admin/firestore'), 'Timestamp' | 'FieldValue'> {
  const { Timestamp, FieldValue } = require('firebase-admin/firestore') as typeof import('firebase-admin/firestore');
  return { Timestamp, FieldValue };
}
