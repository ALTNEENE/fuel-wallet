import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  patchAdminStation,
  patchAdminUser,
  runReconciliation,
} from '../src/controllers/admin.controller.js';
import { createPayment } from '../src/controllers/payments.controller.js';
import { createTopup } from '../src/controllers/topups.controller.js';
import { createTransfer } from '../src/controllers/transfers.controller.js';
import { prisma } from '../src/db/prisma.js';
import { AppError } from '../src/errors/app-error.js';
import {
  TransactionStatus,
  TransactionType,
  WalletType,
} from '../src/generated/prisma/client.js';
import { expirePendingTransactions } from '../src/jobs/expire-pending.job.js';
import { ensureUserByClerkId } from '../src/middleware/ensure-user.js';
import type { TransactionDto } from '../src/repositories/transaction.repository.js';
import { walletRepository } from '../src/repositories/wallet.repository.js';
import { bankSimulatorService } from '../src/services/bank-simulator.service.js';
import {
  type ReconciliationReport,
  reconcileService,
} from '../src/services/reconcile.service.js';
import { sha256 } from '../src/utils/hash.js';

const createdClerkIds: string[] = [];
const tempStationIds: string[] = [];

function createMockRes(): {
  getStatus: () => number;
  getBody: () => { data: unknown };
  res: Response;
} {
  let statusCode = 0;
  let jsonBody: { data: unknown } = { data: null };

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    set() {
      return this;
    },
    json(payload: { data: unknown }) {
      jsonBody = payload;
      return this;
    },
  } as unknown as Response;

  return {
    getStatus: () => statusCode,
    getBody: () => jsonBody,
    res,
  };
}

describe('Phase 8: Integrity, ops, and admin tools', () => {
  after(async () => {
    await bankSimulatorService.setStatus('UP');

    if (createdClerkIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { clerkUserId: { in: createdClerkIds } },
        select: { id: true },
      });
      const userIds = users.map((u) => u.id);

      if (userIds.length > 0) {
        const txns = await prisma.transaction.findMany({
          where: { userId: { in: userIds } },
          select: {
            id: true,
            type: true,
            status: true,
            amount: true,
            toWalletId: true,
          },
        });
        const txnIds = txns.map((t) => t.id);

        const topupSum = txns
          .filter(
            (t) =>
              t.type === TransactionType.TOPUP &&
              t.status === TransactionStatus.COMPLETED,
          )
          .reduce((acc, t) => acc + t.amount, 0n);

        const revenueAdjustments = new Map<string, bigint>();
        for (const t of txns) {
          if (
            t.type === TransactionType.PAYMENT &&
            t.status === TransactionStatus.COMPLETED
          ) {
            revenueAdjustments.set(
              t.toWalletId,
              (revenueAdjustments.get(t.toWalletId) ?? 0n) + t.amount,
            );
          }
        }

        if (txnIds.length > 0) {
          await prisma.$transaction([
            prisma.$executeRaw`ALTER TABLE "ledger_entries" DISABLE TRIGGER trg_ledger_immutable`,
            prisma.ledgerEntry.deleteMany({
              where: { transactionId: { in: txnIds } },
            }),
            prisma.$executeRaw`ALTER TABLE "ledger_entries" ENABLE TRIGGER trg_ledger_immutable`,
            prisma.transaction.deleteMany({
              where: { id: { in: txnIds } },
            }),
          ]);
        }

        if (topupSum > 0n) {
          await prisma.wallet.updateMany({
            where: { type: WalletType.BANK_SIM },
            data: { balance: { increment: topupSum } },
          });
        }

        for (const [revWalletId, sum] of revenueAdjustments.entries()) {
          await prisma.wallet.update({
            where: { id: revWalletId },
            data: { balance: { decrement: sum } },
          });
        }

        await prisma.wallet.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: userIds } },
        });
      }
    }

    if (tempStationIds.length > 0) {
      await prisma.wallet.deleteMany({
        where: { stationId: { in: tempStationIds } },
      });
      await prisma.station.deleteMany({
        where: { id: { in: tempStationIds } },
      });
    }

    await prisma.$disconnect();
  });

  it('Reconcile returns ok:true after top-up/transfer/payment flow, and reports WALLET_BALANCE_MISMATCH + SYSTEM_BALANCE_SUM_NON_ZERO when a balance is corrupted', async () => {
    await bankSimulatorService.setStatus('UP');

    const clerkUserId = `user_phase8_rec_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const user = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'مستخدم المطابقة',
      phone: null,
    }));

    const station = await prisma.station.findFirstOrThrow({
      where: { isActive: true },
    });
    const mainWallet = await walletRepository.getMainWallet(user.id);

    // 1. Top-up 20000
    await createTopup(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p8-topup-${randomUUID().slice(0, 12)}`,
        body: { amount: 20000 },
      } as unknown as Request,
      createMockRes().res,
    );

    // 2. Transfer 12000 to station
    const mockTransfer = createMockRes();
    await createTransfer(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p8-xfer-${randomUUID().slice(0, 12)}`,
        body: {
          fromWalletId: mainWallet.id,
          to: { type: 'STATION', stationId: station.id },
          amount: 12000,
        },
      } as unknown as Request,
      mockTransfer.res,
    );
    const stationWalletId = (mockTransfer.getBody().data as TransactionDto).toWalletId;

    // 3. Pay 5000 at station
    await createPayment(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p8-pay-${randomUUID().slice(0, 12)}`,
        body: {
          stationId: station.id,
          sourceWalletId: stationWalletId,
          amount: 5000,
        },
      } as unknown as Request,
      createMockRes().res,
    );

    // 4. GET /api/admin/reconcile returns ok: true
    const mockReconcile = createMockRes();
    await runReconciliation({} as unknown as Request, mockReconcile.res);
    assert.equal(mockReconcile.getStatus(), 200);
    const cleanReport = mockReconcile.getBody().data as ReconciliationReport;
    assert.equal(cleanReport.ok, true, `Expected ok:true, got issues: ${JSON.stringify(cleanReport.issues)}`);
    assert.equal(cleanReport.issues.length, 0);

    // 5. Corrupting a balance inside a rolled-back scratch transaction makes reconcile report the issue
    let corruptedReport: ReconciliationReport | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.wallet.update({
          where: { id: mainWallet.id },
          data: { balance: { increment: 777n } },
        });

        corruptedReport = await reconcileService.reconcile(tx);
        throw new Error('__ROLLBACK_CORRUPTION__');
      });
    } catch (err) {
      if (!(err instanceof Error && err.message === '__ROLLBACK_CORRUPTION__')) {
        throw err;
      }
    }

    assert.ok(corruptedReport);
    const report = corruptedReport as ReconciliationReport;
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some(
        (i) => i.check === 'WALLET_BALANCE_MISMATCH' && i.walletId === mainWallet.id,
      ),
      'Must report WALLET_BALANCE_MISMATCH for the corrupted wallet',
    );
    assert.ok(
      report.issues.some((i) => i.check === 'SYSTEM_BALANCE_SUM_NON_ZERO'),
      'Must report SYSTEM_BALANCE_SUM_NON_ZERO when total sum != 0',
    );
  });

  it('Aged PENDING transaction flips to FAILED/TIMEOUT; deactivating station blocks payments with STATION_INACTIVE; freezing user blocks writes with ACCOUNT_FROZEN', async () => {
    const clerkUserId = `user_phase8_ops_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const user = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'مستخدم العمليات',
      phone: null,
    }));

    const mainWallet = await walletRepository.getMainWallet(user.id);

    // Create a temporary station with a revenue wallet
    const tempStation = await prisma.station.create({
      data: {
        name: `محطة إدارة ${randomUUID().slice(0, 6)}`,
        city: 'بحري',
        isActive: true,
      },
    });
    tempStationIds.push(tempStation.id);

    const tempRevenueWallet = await prisma.wallet.create({
      data: {
        type: WalletType.STATION_REVENUE,
        stationId: tempStation.id,
        balance: 0n,
      },
    });

    // 1. Insert an aged PENDING transaction (created 5 minutes ago)
    const agedPending = await prisma.transaction.create({
      data: {
        type: TransactionType.PAYMENT,
        status: TransactionStatus.PENDING,
        userId: user.id,
        fromWalletId: mainWallet.id,
        toWalletId: tempRevenueWallet.id,
        amount: 1000n,
        idempotencyKey: `p8-aged-${randomUUID().slice(0, 12)}`,
        requestHash: sha256('p8-aged'),
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    });

    const expiredCount = await expirePendingTransactions(60);
    assert.ok(expiredCount >= 1, 'Expected at least 1 expired PENDING transaction');

    const flipped = await prisma.transaction.findUniqueOrThrow({
      where: { id: agedPending.id },
    });
    assert.equal(flipped.status, TransactionStatus.FAILED);
    assert.equal(flipped.failureCode, 'TIMEOUT');
    assert.ok(flipped.completedAt);

    // 2. PATCH /api/admin/stations/:id { isActive: false } -> payments to it fail with STATION_INACTIVE
    const mockDeactivate = createMockRes();
    await patchAdminStation(
      {
        params: { id: tempStation.id },
        body: { isActive: false },
      } as unknown as Request,
      mockDeactivate.res,
    );
    assert.equal(mockDeactivate.getStatus(), 200);

    await assert.rejects(
      () =>
        createPayment(
          {
            user: { id: user.id, role: user.role, status: user.status },
            idempotencyKey: `p8-inact-pay-${randomUUID().slice(0, 12)}`,
            body: {
              stationId: tempStation.id,
              sourceWalletId: mainWallet.id,
              amount: 1000,
            },
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'STATION_INACTIVE' &&
        err.httpStatus === 422,
    );

    // 3. PATCH /api/admin/users/:id { status: 'FROZEN' } -> writes fail with ACCOUNT_FROZEN
    const mockFreeze = createMockRes();
    await patchAdminUser(
      {
        params: { id: user.id },
        body: { status: 'FROZEN' },
      } as unknown as Request,
      mockFreeze.res,
    );
    assert.equal(mockFreeze.getStatus(), 200);

    await assert.rejects(
      () =>
        createTopup(
          {
            user: { id: user.id, role: user.role, status: 'ACTIVE' },
            idempotencyKey: `p8-frozen-topup-${randomUUID().slice(0, 12)}`,
            body: { amount: 2000 },
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'ACCOUNT_FROZEN' &&
        err.httpStatus === 403,
    );
  });
});

