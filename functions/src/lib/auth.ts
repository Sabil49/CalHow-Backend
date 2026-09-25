import type { Request, Response } from 'express';
import { getAdminAuth } from './firebaseAdmin';
import { ApiRouteError, jsonError } from './apiResponse';

/**
 * Authentication for requests coming from the Expo app.
 *
 * The mobile client (calhow-mobile/services/api.ts) sends
 * `Authorization: Bearer <Firebase ID token>` on every request, obtained
 * fresh per-call via `auth.currentUser.getIdToken()`. That's already
 * implemented on the mobile side — nothing changes there.
 *
 * `withAuth` wraps an HTTPS function handler so identity verification
 * happens exactly once, in exactly one place, before any business logic
 * runs:
 *   1. Read the Authorization header.
 *   2. Verify the token with the Admin SDK (`verifyIdToken`).
 *   3. Pass the verified `uid` into the handler.
 *
 * The verified uid is the ONLY source of identity anywhere in this
 * backend. Nothing in a request body is ever trusted for identity — a
 * client could put any uid it wants in a JSON body, so handler/service
 * code must always use the uid this wrapper provides, never one read from
 * `req.body`.
 */

export interface AuthedContext {
  uid: string;
}

type AuthedHandler = (req: Request, res: Response, ctx: AuthedContext) => Promise<void>;

export function withAuth(handler: AuthedHandler) {
  return async function wrappedHandler(req: Request, res: Response): Promise<void> {
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);

    if (!token) {
      jsonError(res, 'unauthenticated', 'Missing or malformed Authorization header.');
      return;
    }

    let uid: string;
    try {
      const decoded = await getAdminAuth().verifyIdToken(token);
      uid = decoded.uid;
    } catch {
      // Deliberately vague to the client (expired/invalid/malformed all
      // look the same from outside) — no need to leak which.
      jsonError(res, 'unauthenticated', 'Your session has expired or is invalid. Please sign in again.');
      return;
    }

    try {
      await handler(req, res, { uid });
    } catch (err) {
      if (err instanceof ApiRouteError) {
        // Logged so failures are diagnosable from Cloud Logging — before
        // this, a 502 showed up with no reason at all. code + message only:
        // messages never contain image data or secrets (see each thrower).
        // eslint-disable-next-line no-console
        console.warn(`[functions] ${req.path || 'request'} failed: ${err.code} — ${err.message}`);
        jsonError(res, err.code, err.message);
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[functions] unhandled error', err);
      jsonError(res, 'internal_error', 'Something went wrong. Please try again.');
    }
  };
}

function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
