import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';
import { ERROR_CATALOG } from '../errors/catalog.js';

/**
 * Global Express error-handling middleware.
 * - AppError -> { error: { code, message, details? } }
 * - ZodError -> VALIDATION_ERROR 400 with field details
 * - unknown -> INTERNAL 500 (logged server-side, never leaks stack)
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    const fieldSummary = details
      .map((d) => (d.field ? `${d.field}: ${d.message}` : d.message))
      .join('، ');

    res.status(ERROR_CATALOG.VALIDATION_ERROR.httpStatus).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: fieldSummary
          ? `${ERROR_CATALOG.VALIDATION_ERROR.message}: ${fieldSummary}`
          : ERROR_CATALOG.VALIDATION_ERROR.message,
        details,
      },
    });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(ERROR_CATALOG.INTERNAL.httpStatus).json({
    error: {
      code: 'INTERNAL',
      message: ERROR_CATALOG.INTERNAL.message,
    },
  });
}
