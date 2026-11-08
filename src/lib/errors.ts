/** Errors thrown anywhere in a request end up as `{ error: { code, message, details } }` (see middleware/error.ts). */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Please sign in again') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have access to this') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Item') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details);
