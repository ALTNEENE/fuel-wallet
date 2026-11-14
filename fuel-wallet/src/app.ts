import path from 'node:path';
import { clerkMiddleware } from '@clerk/express';
import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import { prisma } from './db/prisma.js';
import { AppError } from './errors/app-error.js';
import { errorHandler } from './middleware/error-handler.js';
import { apiRateLimiter } from './middleware/rate-limit.js';
import { apiRouter } from './routes/index.js';
import { bigIntReplacer } from './utils/serialize.js';

/**
 * Creates and configures the Express 5 application instance.
 */
export function createApp(): Express {
  const app = express();

  app.set('json replacer', (_k: string, v: unknown) =>
    typeof v === 'bigint' ? Number(v) : bigIntReplacer(_k, v),
  );

  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));
  app.use(clerkMiddleware());
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.get('/health', async (_req: Request, res: Response) => {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', database: 'up' });
  });

  app.use('/api', apiRateLimiter, apiRouter);

  app.all('/api/*splat', (_req: Request, _res: Response) => {
    throw new AppError('NOT_FOUND', 404, 'API route not found');
  });

  app.use(errorHandler);

  return app;
}

export const app = createApp();