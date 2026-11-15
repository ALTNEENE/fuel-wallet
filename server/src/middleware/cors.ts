import type { NextFunction, Request, Response } from 'express';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://fuel-wallet-three.vercel.app',
  'fuel-wallet-frontend.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

function isAllowedOrigin(origin: string): boolean {
  const configured = process.env.CORS_ORIGIN?.trim();
  if (!configured || configured === '*') {
    return true;
  }

  const allowedList = configured
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const normalizedOrigin = origin.replace(/\/+$/, '');
  if (
    allowedList.includes(normalizedOrigin) ||
    DEFAULT_ALLOWED_ORIGINS.includes(normalizedOrigin)
  ) {
    return true;
  }

  // Also allow Vercel preview deployment URLs (*.vercel.app)
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalizedOrigin)) {
    return true;
  }

  return false;
}

/**
 * Cross-Origin Resource Sharing (CORS) middleware.
 * Handles `OPTIONS` preflight requests and exposes custom headers
 * (`Authorization`, `Idempotency-Key`, `Idempotency-Replayed`, `X-Request-Id`)
 * for cross-origin deployments (e.g. Vercel frontend -> Render backend).
 */
export function corsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const origin = req.headers.origin;

  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS',
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, Idempotency-Key, X-Request-Id',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Idempotency-Replayed, X-Request-Id',
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}

