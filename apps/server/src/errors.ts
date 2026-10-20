/**
 * Errors returned to clients as `{ error: { code, message } }`.
 * `code` is stable and documented in docs/architecture/server-api.md; `message` is for humans.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const unauthorized = (message = "Sign in required", code = "unauthorized") => new HttpError(401, code, message);
export const forbidden = (message = "You do not have permission to do this", code = "forbidden") => new HttpError(403, code, message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict", details?: unknown) => new HttpError(409, code, message, details);
