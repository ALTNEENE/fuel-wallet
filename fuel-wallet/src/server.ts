import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import {
  startExpirePendingJob,
  stopExpirePendingJob,
} from './jobs/expire-pending.job.js';

startExpirePendingJob();

const server = app.listen(env.PORT, () => {
  console.log(`Fuel Wallet server listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  stopExpirePendingJob();
  server.close(async () => {
    try {
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      console.error('Error disconnecting Prisma client:', err);
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
