/**
 * Every failure the API reports on purpose is an `ApiError`. The global
 * `onError` handler turns it into `{ error: { code, message } }` with the
 * right status and headers; anything else becomes an opaque 500.
 *
 * Status semantics (fixed by the API contract):
 *   401 bad or missing credentials · 403 policy · 404 unknown resource
 *   409 request-id conflict · 413 body too large · 429 rate limit (+ Retry-After)
 *   502 upstream (Ask's model call) failed · 503 a feature is not set up
 */
export type ApiStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503;

export class ApiError extends Error {
  constructor(
    readonly status: ApiStatus,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toResponse(): Response {
    return Response.json(
      { error: { code: this.code, message: this.message } },
      { status: this.status, headers: { ...this.headers } },
    );
  }
}

export const errors = {
  badRequest: (code: string, message: string) => new ApiError(400, code, message),

  unauthorized: () =>
    new ApiError(401, 'unauthorized', 'Missing or invalid installation token.', {
      'WWW-Authenticate': 'Bearer realm="feedbackkit"',
    }),

  forbidden: (message: string, code = 'forbidden') => new ApiError(403, code, message),

  notFound: (code: string, message: string) => new ApiError(404, code, message),

  conflict: (message: string, code = 'request_id_conflict') => new ApiError(409, code, message),

  payloadTooLarge: () =>
    new ApiError(413, 'payload_too_large', 'Request body must be 1 MiB or smaller.'),

  rateLimited: (retryAfterSeconds: number) =>
    new ApiError(429, 'rate_limited', 'Too many requests. Please try again shortly.', {
      'Retry-After': String(retryAfterSeconds),
    }),
};
