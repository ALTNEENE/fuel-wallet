import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { Request, Response } from 'express';
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
import { ensureUserByClerkId } from '../src/middleware/ensure-user.js';
import type { TransactionDto } from '../src/repositories/transaction.repository.js';
import { walletRepository } from '../src/repositories/wallet.repository.js';
import { bankSimulatorService } from '../src/services/bank-simulator.service.js';

const createdClerkIds: string[] = [];

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

describe('Phase 6: Payments (POST /api/payments)', () => {
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

        // Compute completed payment amounts per destination revenue wallet to restore
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

    await prisma.$disconnect();
  });

  it('Full competition flow: top-up 30000 -> main to A 20000 -> pay 12000 at A (leaves 8000, revenue +12000, 6-digit verificationCode) -> A to B 8000 -> pay full 8000 at B with bank DOWN (leaves 0)', async () => {
    await bankSimulatorService.setStatus('UP');

    const clerkUserId = `user_phase6_flow_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const user = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'سائق المسابقة',
      phone: '+249912349999',
    }));

    const stations = await prisma.station.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      take: 2,
    });
    assert.equal(stations.length, 2);
    const stationA = stations[0]!;
    const stationB = stations[1]!;

    const revABefore = await walletRepository.getRevenueWallet(stationA.id);
    const revBBefore = await walletRepository.getRevenueWallet(stationB.id);
    const mainWallet = await walletRepository.getMainWallet(user.id);

    // 1. Top-up 30000
    await createTopup(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p6-topup-${randomUUID().slice(0, 12)}`,
        body: { amount: 30000 },
      } as unknown as Request,
      createMockRes().res,
    );

    // 2. Transfer 20000 from MAIN to Station A
    const mockMainToA = createMockRes();
    await createTransfer(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p6-m2a-${randomUUID().slice(0, 12)}`,
        body: {
          fromWalletId: mainWallet.id,
          to: { type: 'STATION', stationId: stationA.id },
          amount: 20000,
        },
      } as unknown as Request,
      mockMainToA.res,
    );
    const walletAId = (mockMainToA.getBody().data as TransactionDto).toWalletId;

    // 3. Pay 12000 at Station A from Station A wallet -> leaves 8000, revenue +12000
    const mockPayA = createMockRes();
    await createPayment(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p6-paya-${randomUUID().slice(0, 12)}`,
        body: {
          stationId: stationA.id,
          sourceWalletId: walletAId,
          amount: 12000,
        },
      } as unknown as Request,
      mockPayA.res,
    );
    assert.equal(mockPayA.getStatus(), 201);
    const dtoPayA = mockPayA.getBody().data as TransactionDto;
    assert.equal(dtoPayA.type, TransactionType.PAYMENT);
    assert.equal(dtoPayA.status, TransactionStatus.COMPLETED);
    assert.equal(dtoPayA.balanceAfter.from, 8000);
    assert.equal(dtoPayA.balanceAfter.to, Number(revABefore.balance) + 12000);
    assert.ok(dtoPayA.verificationCode);
    assert.match(dtoPayA.verificationCode, /^\d{6}$/);

    // 4. Transfer remaining 8000 from Station A to Station B
    const mockAToB = createMockRes();
    await createTransfer(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p6-a2b-${randomUUID().slice(0, 12)}`,
        body: {
          fromWalletId: walletAId,
          to: { type: 'STATION', stationId: stationB.id },
          amount: 8000,
        },
      } as unknown as Request,
      mockAToB.res,
    );
    const walletBId = (mockAToB.getBody().data as TransactionDto).toWalletId;

    // 5. Paying at Station A from Station B's balance -> 422 WRONG_STATION_BALANCE
    await assert.rejects(
      () =>
        createPayment(
          {
            user: { id: user.id, role: user.role, status: user.status },
            idempotencyKey: `p6-wrongst-${randomUUID().slice(0, 12)}`,
            body: {
              stationId: stationA.id,
              sourceWalletId: walletBId,
              amount: 1000,
            },
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'WRONG_STATION_BALANCE' &&
        err.httpStatus === 422,
    );

    // 6. Paying more than the balance -> 422 INSUFFICIENT_FUNDS with a FAILED row
    const overpayKey = `p6-overpay-${randomUUID().slice(0, 12)}`;
    await assert.rejects(
      () =>
        createPayment(
          {
            user: { id: user.id, role: user.role, status: user.status },
            idempotencyKey: overpayKey,
            body: {
              stationId: stationB.id,
              sourceWalletId: walletBId,
              amount: 9000,
            },
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'INSUFFICIENT_FUNDS' &&
        err.httpStatus === 422,
    );

    const failedOverpay = await prisma.transaction.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: user.id,
          idempotencyKey: overpayKey,
        },
      },
    });
    assert.ok(failedOverpay);
    assert.equal(failedOverpay.status, TransactionStatus.FAILED);
    assert.equal(failedOverpay.failureCode, 'INSUFFICIENT_FUNDS');

    // 7. Paying with the bank DOWN still works, and paying exact full balance (8000) leaves 0
    await bankSimulatorService.setStatus('DOWN');
    const mockPayB = createMockRes();
    await createPayment(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p6-payb-${randomUUID().slice(0, 12)}`,
        body: {
          stationId: stationB.id,
          sourceWalletId: walletBId,
          amount: 8000,
        },
      } as unknown as Request,
      mockPayB.res,
    );
    assert.equal(mockPayB.getStatus(), 201);
    const dtoPayB = mockPayB.getBody().data as TransactionDto;
    assert.equal(dtoPayB.balanceAfter.from, 0, 'Exact full balance payment must leave 0');
    assert.equal(dtoPayB.balanceAfter.to, Number(revBBefore.balance) + 8000);
    assert.ok(dtoPayB.verificationCode);
    assert.match(dtoPayB.verificationCode, /^\d{6}$/);
  });

  it('10 parallel 5000 payments via POST /api/payments from a 20000 balance yield† 4 COMPLETED and 6 FAILED INSUFFICIENT_FUNDS', async () => {
    const clerkUserId = `user_phase6_race_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const user = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'متسابق الدفع المتوازي',
      phone: null,
    }));

    const mainWallet = await walletRepository.getMainWallet(user.id);
    await prisma.wallet.update({
      where: { id: mainWallet.id },
      data: { balance: 20000n },
    });

    const station = await prisma.station.findFirstOrThrow({
      where: { isActive: true },
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        createPayment(
          {
            user: { id: user.id, role: user.role, status: user.status },
            idempotencyKey: `p6-race-${i}-${randomUUID().slice(0, 8)}`,
            body: {
              stationId: station.id,
              sourceWalletId: mainWallet.id,
              amount: 5000,
            },
          } as unknown as Request,
          createMockRes().res,
        ),
      ),
    );

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );

    assert.equal(fulfilled.length, 4, 'Expected exactly 4 COMPLETED payments');
    assert.equal(rejected.length, 6, 'Expected exactly 6 FAILED payments');
    for (const r of rejected) {
      assert.ok(r.reason instanceof AppError);
      assert.equal(r.reason.code, 'INSUFFICIENT_FUNDS');
      assert.equal(r.reason.httpStatus, 422);
    }

    const updatedMain = await walletRepository.getMainWallet(user.id);
    assert.equal(updatedMain.balance, 0n);
  });
});

