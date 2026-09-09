import { NextResponse, type NextRequest } from 'next/server';

/**
 * A shipped mobile build (fixed in the app but already out in TestFlight)
 * can send request paths with a doubled slash, e.g. `/api//meals/analyze`,
 * from joining a base URL with a trailing slash to a path with a leading
 * one. Next.js/Vercel would otherwise 308-redirect that to the collapsed
 * path, and a cross-request redirect drops the `Authorization` header —
 * the client's retry then hits `withAuth` with no header at all.
 *
 * Collapsing it here via an internal rewrite (not a redirect) keeps the
 * original request — headers included — intact.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.includes('//')) {
    const url = req.nextUrl.clone();
    url.pathname = pathname.replace(/\/{2,}/g, '/');
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
