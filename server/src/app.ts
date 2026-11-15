import path from 'node:path';
import { clerkMiddleware } from '@clerk/express';
import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { prisma } from './db/prisma.js';
import { openApiSpec } from './docs/swagger.js';
import { AppError } from './errors/app-error.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { apiRateLimiter } from './middleware/rate-limit.js';
import { requestLogger } from './middleware/request-logger.js';
import { apiRouter } from './routes/index.js';
import { bigIntReplacer } from './utils/serialize.js';

/**
 * Creates and configures the Express 5 application instance.
 */
export function createApp(): Express {
  const app = express();

  // Trust first proxy hop (e.g. Render / reverse proxy) so rate limiters read real client IP
  app.set('trust proxy', 1);

  app.set('json replacer', (_k: string, v: unknown) =>
    typeof v === 'bigint' ? Number(v) : bigIntReplacer(_k, v),
  );

  // Mount CORS middleware first so OPTIONS preflight requests succeed before auth/rate-limiting
  app.use(corsMiddleware);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(express.json({ limit: '10kb' }));
  app.use(requestLogger);
  app.use(clerkMiddleware());
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Swagger / OpenAPI 3.0 Interactive Documentation & Raw Spec
  app.get('/api-docs.json', (_req: Request, res: Response) => {
    res.status(200).json(openApiSpec);
  });

  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: 'Fuel Wallet API Docs — توثيق محفظة الوقود الرقمية',
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
      },
    }),
  );

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
