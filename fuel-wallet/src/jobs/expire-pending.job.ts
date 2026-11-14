import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ERROR_CATALOG } from '../errors/catalog.js';

let expireInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Sets PENDING transactions older than `timeoutSeconds` (default `PENDING_TIMEOUT_SECONDS`)
 * to `FAILED` with `failure_code = 'TIMEOUT'`.
 */
export async function expirePendingTransactions(
  timeoutSeconds: number = env.PENDING_TIMEOUT_SECONDS,
): Promise<number> {
  const affected = await prisma.$executeRaw`
    UPDATE "transactions"
    SET
      "status" = 'FAILED'::"TransactionStatus",
      "failure_code" = 'TIMEOUT',
      "failure_reason" = ${ERROR_CATALOG.TIMEOUT.message},
      "completed_at" = NOW()
    WHERE "status" = 'PENDING'::"TransactionStatus"
      AND "created_at" < NOW() - (${timeoutSeconds} * INTERVAL '1 second')
  `;

  return Number(affected);
}

/**
 * Starts the 30-second periodic job to expire stale PENDING transactions (`interval.unref()`).
 */
export function startExpirePendingJob(
  intervalMs = 30_000,
): ReturnType<typeof setInterval> {
  if (expireInterval) {
    return expireInterval;
  }

  expireInterval = setInterval(() => {
    void expirePendingTransactions().catch((err) => {
      console.error('Error expiring pending transactions:', err);
    });
  }, intervalMs);

  expireInterval.unref();
  return expireInterval;
}

/**
 * Stops the periodic pending-transaction expiration timer on graceful shutdown.
 */
export function stopExpirePendingJob(): void {
  if (expireInterval) {
    clearInterval(expireInterval);
    expireInterval = null;
  }
}
