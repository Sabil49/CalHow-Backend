import type { NextRequest } from 'next/server';
import { getAdminAuth } from './firebaseAdmin';
import { ApiRouteError, jsonError } from './apiResponse';

/**
 * Authentication for requests coming from the Expo app.
 *
 * The mobile client (calhow/services/api.ts) sends
 * `Authorization: Bearer <Firebase ID token>` on every request, obtained
 * fresh per-call via `auth.currentUser.getIdToken()`. That's already
 * implemented on the mobile side — nothing changes there.
 *
 * `withAuth` wraps a route handler so identity verification happens
 * exactly once, in exactly one place, before any business logic runs:
 *   1. Read the Authorization header.
 *   2. Verify the token with the Admin SDK (`verifyIdToken`).
 *   3. Pass the verified `uid` into the handler.
 *
 * The verified uid is the ONLY source of identity anywhere in this
 * backend. Nothing in a request body is ever trusted for identity — a
 * client could put any uid it wants in a JSON body, so route/service code
 * must always use the uid this wrapper provides, never one read from
 * `req.json()`.
 */

export interface AuthedContext {
  uid: string;
}

type AuthedHandler = (req: NextRequest, ctx: AuthedContext) => Promise<Response>;

export function withAuth(handler: AuthedHandler) {
  return async function wrappedHandler(req: NextRequest): Promise<Response> {
    const authHeader = req.headers.get('authorization') ?? req.headers.get('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      return jsonError('unauthenticated', 'Missing or malformed Authorization header.');
    }

    let uid: string;
    try {
      const decoded = await getAdminAuth().verifyIdToken(token);
      uid = decoded.uid;
    } catch {
      // Deliberately vague to the client (expired/invalid/malformed all
      // look the same from outside) — no need to leak which.
      return jsonError('unauthenticated', 'Your session has expired or is invalid. Please sign in again.');
    }

    try {
      return await handler(req, { uid });
    } catch (err) {
      if (err instanceof ApiRouteError) {
        return jsonError(err.code, err.message);
      }
      // eslint-disable-next-line no-console
      console.error('[api] unhandled error', err);
      return jsonError('internal_error', 'Something went wrong. Please try again.');
    }
  };
}

function extractBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
