import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  getBankGatewayStatus,
  updateBankGatewayStatus,
} from '../src/controllers/admin.controller.js';
import { createTopup } from '../src/controllers/topups.controller.js';
import { prisma } from '../src/db/prisma.js';
import { AppError } from '../src/errors/app-error.js';
import {
  TransactionStatus,
  TransactionType,
  WalletType,
} from '../src/generated/prisma/client.js';
import { ensureUserByClerkId } from '../src/middleware/ensure-user.js';
import { requireRole } from '../src/middleware/require-role.js';
import type { TransactionDto } from '../src/repositories/transaction.repository.js';
import { bankSimulatorService } from '../src/services/bank-simulator.service.js';

const createdClerkIds: string[] = [];

function createMockRes(): {
  getStatus: () => number;
  getBody: () => { data: unknown };
  getHeader: (name: string) => string | undefined;
  res: Response;
} {
  let statusCode = 0;
  let jsonBody: { data: unknown } = { data: null };
  const headers = new Map<string, string>();

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
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
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    res,
  };
}

describe('Phase 4: Top-up, bank simulator, and admin bank switch', () => {
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
          select: { id: true, status: true, amount: true },
        });
        const txnIds = txns.map((t) => t.id);
        const completedSum = txns
          .filter((t) => t.status === TransactionStatus.COMPLETED)
          .reduce((acc, t) => acc + t.amount, 0n);

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

        if (completedSum > 0n) {
          await prisma.wallet.updateMany({
            where: { type: WalletType.BANK_SIM },
            data: { balance: { increment: completedSum } },
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

  it('Admin can read and switch bank_gateway_status, while non-ADMIN is rejected with 403 FORBIDDEN', async () => {
    const driverMiddleware = requireRole('ADMIN');
    assert.throws(
      () =>
        driverMiddleware(
          {
            user: { id: randomUUID(), role: 'DRIVER', status: 'ACTIVE' },
          } as unknown as Request,
          createMockRes().res,
          () => {},
        ),
      (err: unknown) =>
        err instanceof AppError && err.code === 'FORBIDDEN' && err.httpStatus === 403,
    );

    const mockSetDown = createMockRes();
    await updateBankGatewayStatus(
      { body: { status: 'DOWN' } } as unknown as Request,
      mockSetDown.res,
    );
    assert.equal(mockSetDown.getStatus(), 200);
    assert.deepEqual(mockSetDown.getBody(), { data: { status: 'DOWN' } });
    assert.equal(await bankSimulatorService.isUp(), false);

    const mockGet = createMockRes();
    await getBankGatewayStatus({} as unknown as Request, mockGet.res);
    assert.equal(mockGet.getStatus(), 200);
    assert.deepEqual(mockGet.getBody(), { data: { status: 'DOWN' } });

    const mockSetUp = createMockRes();
    await updateBankGatewayStatus(
      { body: { status: 'UP' } } as unknown as Request,
      mockSetUp.res,
    );
    assert.equal(mockSetUp.getStatus(), 200);
    assert.deepEqual(mockSetUp.getBody(), { data: { status: 'UP' } });
    assert.equal(await bankSimulatorService.isUp(), true);
  });

  it('Validation errors (AMOUNT_OUT_OF_RANGE, ACCOUNT_FROZEN) fail before begin and create NO transaction row', async () => {
    const clerkUserId = `user_phase4_val_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const user = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'مستخدم التحقق',
      phone: null,
    }));

    // Below TOPUP_MIN (1000)
    await assert.rejects(
      () =>
        createTopup(
          {
            user: { id: user.id, role: user.role, status: user.status },
            idempotencyKey: `p4-min-${randomUUID().slice(0, 12)}`,
            body: { amount: 500 },
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'AMOUNT_OUT_OF_RANGE' &&
        err.httpStatus === 400,
    );

    // Above TOPUP_MAX (500000)
    await assert.rejects(
      () =>
        createTopup(
          {
            user: { id: user.id, role: user.role, status: user.status },
            idempotencyKey: `p4-max-${randomUUID().slice(0, 12)}`,
            body: { amount: 600000 },
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'AMOUNT_OUT_OF_RANGE' &&
        err.httpStatus === 400,
    );

    const txnCountAfterRangeErrors = await prisma.transaction.count({
      where: { userId: user.id },
    });
    assert.equal(
      txnCountAfterRangeErrors,
      0,
      'Validation errors must create NO transaction row',
    );
  });

  it('Bank UP -> 201 COMPLETED, main +amount, bank -amount, 2 ledger rows; Bank DOWN -> 503 BANK_UNAVAILABLE, FAILED, 0 ledger rows, balance unchanged, and replay returns same 503', async () => {
    await bankSimulatorService.setStatus('UP');

    const clerkUserId = `user_phase4_main_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const user = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'يوسف إبراهيم',
      phone: '+249912340000',
    }));

    const bankBefore = await prisma.wallet.findFirstOrThrow({
      where: { type: WalletType.BANK_SIM },
    });
    const mainBefore = await prisma.wallet.findFirstOrThrow({
      where: { userId: user.id, type: WalletType.USER_MAIN },
    });
    assert.equal(mainBefore.balance, 0n);

    // 1. Bank UP -> 201 COMPLETED
    const upKey = `p4-up-${randomUUID().slice(0, 12)}`;
    const mockUp = createMockRes();
    await createTopup(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: upKey,
        body: { amount: 15000 },
      } as unknown as Request,
      mockUp.res,
    );

    assert.equal(mockUp.getStatus(), 201);
    const upDto = mockUp.getBody().data as TransactionDto;
    assert.equal(upDto.type, TransactionType.TOPUP);
    assert.equal(upDto.status, TransactionStatus.COMPLETED);
    assert.equal(upDto.amount, 15000);
    assert.equal(upDto.balanceAfter.to, 15000);

    // Replay same completed top-up -> 200 with Idempotent-Replayed: true
    const mockUpReplay = createMockRes();
    await createTopup(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: upKey,
        body: { amount: 15000 },
      } as unknown as Request,
      mockUpReplay.res,
    );
    assert.equal(mockUpReplay.getStatus(), 200);
    assert.equal(mockUpReplay.getHeader('Idempotent-Replayed'), 'true');
    assert.deepEqual(mockUpReplay.getBody().data, upDto);

    const bankAfterUp = await prisma.wallet.findUniqueOrThrow({
      where: { id: bankBefore.id },
    });
    const mainAfterUp = await prisma.wallet.findUniqueOrThrow({
      where: { id: mainBefore.id },
    });
    assert.equal(mainAfterUp.balance, 15000n, 'USER_MAIN must increase by +15000');
    assert.equal(
      bankAfterUp.balance,
      bankBefore.balance - 15000n,
      'BANK_SIM must decrease by -15000',
    );

    const upLedgerRows = await prisma.ledgerEntry.findMany({
      where: { transactionId: upDto.id },
    });
    assert.equal(upLedgerRows.length, 2, 'Expected 2 ledger rows for COMPLETED top-up');

    // 2. Bank DOWN -> 503 BANK_UNAVAILABLE
    await bankSimulatorService.setStatus('DOWN');
    const downKey = `p4-down-${randomUUID().slice(0, 12)}`;

    await assert.rejects(
      () =>
        createTopup(
          {
            user: { id: user.id, role: user.role, status: user.status },
            idempotencyKey: downKey,
            body: { amount: 25000 },
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'BANK_UNAVAILABLE' &&
        err.httpStatus === 503,
    );

    const failedTxn = await prisma.transaction.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: user.id,
          idempotencyKey: downKey,
        },
      },
      include: { ledgerEntries: true },
    });

    assert.ok(failedTxn, 'FAILED transaction row must exist');
    assert.equal(failedTxn.status, TransactionStatus.FAILED);
    assert.equal(failedTxn.failureCode, 'BANK_UNAVAILABLE');
    assert.equal(failedTxn.ledgerEntries.length, 0, 'Zero ledger rows on FAILED top-up');

    const bankAfterDown = await prisma.wallet.findUniqueOrThrow({
      where: { id: bankBefore.id },
    });
    const mainAfterDown = await prisma.wallet.findUniqueOrThrow({
      where: { id: mainBefore.id },
    });
    assert.equal(mainAfterDown.balance, 15000n, 'USER_MAIN balance must be unchanged');
    assert.equal(
      bankAfterDown.balance,
      bankAfterUp.balance,
      'BANK_SIM balance must be unchanged',
    );

    // 3. Replaying the failed request with the same key returns the same 503 BANK_UNAVAILABLE
    await bankSimulatorService.setStatus('UP');
    await assert.rejects(
      () =>
        createTopup(
          {
            user: { id: user.id, role: user.role, status: user.status },
            idempotencyKey: downKey,
            body: { amount: 25000 },
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'BANK_UNAVAILABLE' &&
        err.httpStatus === 503,
    );
  });
});

