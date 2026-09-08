import { NextResponse } from 'next/server';

/**
 * Fixed vocabulary of error codes used across every route in this
 * backend. Keeping this as a closed set (rather than ad-hoc strings per
 * route) means the mobile app's error handling — and any logging/alerting
 * added later — can reason about a known, finite list.
 */
export const API_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'invalid_request',
  'payload_too_large',
  'analysis_not_found',
  'analysis_expired',
  'ai_provider_error',
  'nutrition_lookup_error',
  'image_upload_error',
  'rate_limited',
  'scan_limit_reached',
  'not_implemented',
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 400,
  payload_too_large: 413,
  analysis_not_found: 404,
  analysis_expired: 410,
  ai_provider_error: 502,
  nutrition_lookup_error: 502,
  image_upload_error: 502,
  rate_limited: 429,
  scan_limit_reached: 429,
  not_implemented: 501,
  internal_error: 500,
};

/**
 * Thrown by service/route code to signal a specific, structured API
 * error. Route handlers should catch this (see lib/auth.ts's withAuth)
 * and translate it via `jsonError`, rather than routes constructing
 * ad-hoc error responses inline.
 */
export class ApiRouteError extends Error {
  code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'ApiRouteError';
    this.code = code;
  }
}

/** Success envelope — the mobile app expects the raw response shape (e.g. AnalyzeMealResponse) directly as the body, no extra wrapper. */
export function jsonSuccess<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}

/** Error envelope — matches ApiErrorBody in both this repo's types/api.ts and the mobile app's types/api.ts exactly: { error: { code, message } }. */
export function jsonError(code: ApiErrorCode, message: string, statusOverride?: number) {
  const status = statusOverride ?? STATUS_BY_CODE[code];
  return NextResponse.json({ error: { code, message } }, { status });
}
