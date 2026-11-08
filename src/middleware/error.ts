import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';

import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
};

/** Every error leaves as `{ error: { code, message, details? } }`; unexpected ones are logged, never leaked. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let code = 'INTERNAL';
  let message = 'Something went wrong — please try again';
  let details: unknown;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = err.code;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large' : err.message;
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    code = 'BAD_REQUEST';
    message = Object.values(err.errors)[0]?.message ?? 'Invalid input';
    details = { fields: Object.entries(err.errors).map(([path, e]) => ({ path, message: e.message })) };
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'BAD_REQUEST';
    message = `Invalid ${err.path}`;
  } else if ((err as { code?: number }).code === 11000) {
    status = 409;
    code = 'CONFLICT';
    message = 'This already exists';
    details = { keys: Object.keys((err as { keyValue?: object }).keyValue ?? {}) };
  } else if ((err as { type?: string }).type === 'entity.parse.failed') {
    status = 400;
    code = 'BAD_JSON';
    message = 'The request body is not valid JSON';
  } else if ((err as { type?: string }).type === 'entity.too.large') {
    status = 413;
    code = 'TOO_LARGE';
    message = 'The request is too large';
  }

  if (status >= 500) logger.error({ err, path: req.path, method: req.method }, 'request failed');
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
};
