import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { Request, Response } from 'express';
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

describe('Phase 5: Transfers (POST /api/transfers)', () => {
  after(async () => {
    if (createdClerkIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { clerkUserId: { in: createdClerkIds } },
        select: { id: true },
      });
      const userIds = users.map((u) => u.id);

      if (userIds.length > 0) {
        const txns = await prisma.transaction.findMany({
          where: { userId: { in: userIds } },
          select: { id: true, type: true, status: true, amount: true },
        });
        const txnIds = txns.map((t) => t.id);
        const topupSum = txns
          .filter(
            (t) =>
              t.type === TransactionType.TOPUP &&
              t.status === TransactionStatus.COMPLETED,
          )
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

        if (topupSum > 0n) {
          await prisma.wallet.updateMany({
            where: { type: WalletType.BANK_SIM },
            data: { balance: { increment: topupSum } },
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
      await prisma.station.deleteMany({
        where: { id: { in: tempStationIds } },
      });
    }

    await prisma.$disconnect();
  });

  it('Competition flow: top-up 30000 -> main to station A 20000 -> station A to station B 8000 -> full-balance transfer back to MAIN leaving 0', async () => {
    await bankSimulatorService.setStatus('UP');

    const clerkUserId = `user_phase5_flow_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const user = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'متسابق الوقود',
      phone: '+249912345000',
    }));

    const stations = await prisma.station.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      take: 2,
    });
    assert.equal(stations.length, 2);
    const stationA = stations[0]!;
    const stationB = stations[1]!;

    const mainWallet = await walletRepository.getMainWallet(user.id);

    // 1. Top-up 30000
    const mockTopup = createMockRes();
    await createTopup(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p5-topup-${randomUUID().slice(0, 12)}`,
        body: { amount: 30000 },
      } as unknown as Request,
      mockTopup.res,
    );
    assert.equal(mockTopup.getStatus(), 201);

    // 2. Transfer 20000 from MAIN to Station A
    const mockMainToA = createMockRes();
    await createTransfer(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p5-m2a-${randomUUID().slice(0, 12)}`,
        body: {
          fromWalletId: mainWallet.id,
          to: { type: 'STATION', stationId: stationA.id },
          amount: 20000,
        },
      } as unknown as Request,
      mockMainToA.res,
    );
    assert.equal(mockMainToA.getStatus(), 201);
    const dtoMainToA = mockMainToA.getBody().data as TransactionDto;
    assert.equal(dtoMainToA.type, TransactionType.TRANSFER);
    assert.equal(dtoMainToA.status, TransactionStatus.COMPLETED);
    assert.equal(dtoMainToA.balanceAfter.from, 10000);
    assert.equal(dtoMainToA.balanceAfter.to, 20000);

    const walletAId = dtoMainToA.toWalletId;

    // 3. Transfer 8000 from Station A to Station B
    const mockAToB = createMockRes();
    await createTransfer(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p5-a2b-${randomUUID().slice(0, 12)}`,
        body: {
          fromWalletId: walletAId,
          to: { type: 'STATION', stationId: stationB.id },
          amount: 8000,
        },
      } as unknown as Request,
      mockAToB.res,
    );
    assert.equal(mockAToB.getStatus(), 201);
    const dtoAToB = mockAToB.getBody().data as TransactionDto;
    assert.equal(dtoAToB.balanceAfter.from, 12000);
    assert.equal(dtoAToB.balanceAfter.to, 8000);

    const walletBId = dtoAToB.toWalletId;

    // 4. Full-balance transfer of 8000 from Station B back to MAIN leaving 0
    const mockBToMain = createMockRes();
    await createTransfer(
      {
        user: { id: user.id, role: user.role, status: user.status },
        idempotencyKey: `p5-b2m-${randomUUID().slice(0, 12)}`,
        body: {
          fromWalletId: walletBId,
          to: { type: 'MAIN' },
          amount: 8000,
        },
      } as unknown as Request,
      mockBToMain.res,
    );
    assert.equal(mockBToMain.getStatus(), 201);
    const dtoBToMain = mockBToMain.getBody().data as TransactionDto;
    assert.equal(dtoBToMain.balanceAfter.from, 0, 'Full-balance transfer must leave 0');
    assert.equal(dtoBToMain.balanceAfter.to, 18000);
  });

  it('Transfer into an inactive station -> 422 STATION_INACTIVE with no txn row; transfer OUT of inactive station succeeds; transfer from another user wallet -> 404 NOT_FOUND', async () => {
    const clerkUser1 = `user_phase5_u1_${randomUUID()}`;
    const clerkUser2 = `user_phase5_u2_${randomUUID()}`;
    createdClerkIds.push(clerkUser1, clerkUser2);

    const user1 = await ensureUserByClerkId(clerkUser1, async () => ({
      fullName: 'مستخدم 1',
      phone: null,
    }));
    const user2 = await ensureUserByClerkId(clerkUser2, async () => ({
      fullName: 'مستخدم 2',
      phone: null,
    }));

    const user1Main = await walletRepository.getMainWallet(user1.id);
    const user2Main = await walletRepository.getMainWallet(user2.id);

    const inactiveStation = await prisma.station.create({
      data: {
        name: `محطة متوقفة ${randomUUID().slice(0, 6)}`,
        city: 'الخرطوم',
        isActive: false,
      },
    });
    tempStationIds.push(inactiveStation.id);

    // 1. Transfer INTO inactive station -> 422 STATION_INACTIVE, no txn row
    await assert.rejects(
      () =>
        createTransfer(
          {
            user: { id: user1.id, role: user1.role, status: user1.status },
            idempotencyKey: `p5-inact-${randomUUID().slice(0, 12)}`,
            body: {
              fromWalletId: user1Main.id,
              to: { type: 'STATION', stationId: inactiveStation.id },
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

    const txnCountAfterInactive = await prisma.transaction.count({
      where: { userId: user1.id },
    });
    assert.equal(
      txnCountAfterInactive,
      0,
      'Transfer into inactive station must create NO transaction row',
    );

    // 2. Transfer from someone else's wallet -> 404 NOT_FOUND, no txn row
    await assert.rejects(
      () =>
        createTransfer(
          {
            user: { id: user1.id, role: user1.role, status: user1.status },
            idempotencyKey: `p5-other-${randomUUID().slice(0, 12)}`,
            body: {
              fromWalletId: user2Main.id,
              to: { type: 'MAIN' },
              amount: 1000,
            },
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'NOT_FOUND' &&
        err.httpStatus === 404,
    );

    // 3. Transfer OUT of an inactive station is allowed
    const user1InactiveWallet = await prisma.wallet.create({
      data: {
        type: WalletType.USER_STATION,
        userId: user1.id,
        stationId: inactiveStation.id,
        balance: 3000n,
      },
    });

    const mockOutOfInactive = createMockRes();
    await createTransfer(
      {
        user: { id: user1.id, role: user1.role, status: user1.status },
        idempotencyKey: `p5-outinact-${randomUUID().slice(0, 12)}`,
        body: {
          fromWalletId: user1InactiveWallet.id,
          to: { type: 'MAIN' },
          amount: 3000,
        },
      } as unknown as Request,
      mockOutOfInactive.res,
    );
    assert.equal(mockOutOfInactive.getStatus(), 201);
    const outDto = mockOutOfInactive.getBody().data as TransactionDto;
    assert.equal(outDto.balanceAfter.from, 0);
    assert.equal(outDto.balanceAfter.to, 3000);
  });

  it('Two concurrent transfers of the whole balance -> one COMPLETED and one FAILED INSUFFICIENT_FUNDS', async () => {
    const clerkUserId = `user_phase5_race_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const user = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'مستخدم التنافس',
      phone: null,
    }));

    const mainWallet = await walletRepository.getMainWallet(user.id);
    await prisma.wallet.update({
      where: { id: mainWallet.id },
      data: { balance: 10000n },
    });

    const station = await prisma.station.findFirstOrThrow({
      where: { isActive: true },
    });

    // Ensure destination station wallet exists ahead of time so both transfers lock the same 2 wallets
    await walletRepository.ensureStationWallet(user.id, station.id);

    const outcomes = await Promise.allSettled([
      createTransfer(
        {
          user: { id: user.id, role: user.role, status: user.status },
          idempotencyKey: `p5-race1-${randomUUID().slice(0, 12)}`,
          body: {
            fromWalletId: mainWallet.id,
            to: { type: 'STATION', stationId: station.id },
            amount: 10000,
          },
        } as unknown as Request,
        createMockRes().res,
      ),
      createTransfer(
        {
          user: { id: user.id, role: user.role, status: user.status },
          idempotencyKey: `p5-race2-${randomUUID().slice(0, 12)}`,
          body: {
            fromWalletId: mainWallet.id,
            to: { type: 'STATION', stationId: station.id },
            amount: 10000,
          },
        } as unknown as Request,
        createMockRes().res,
      ),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );

    assert.equal(fulfilled.length, 1, 'Expected exactly 1 COMPLETED transfer');
    assert.equal(rejected.length, 1, 'Expected exactly 1 FAILED transfer');
    assert.ok(rejected[0]!.reason instanceof AppError);
    assert.equal(rejected[0]!.reason.code, 'INSUFFICIENT_FUNDS');
    assert.equal(rejected[0]!.reason.httpStatus, 422);

    const updatedMain = await walletRepository.getMainWallet(user.id);
    assert.equal(updatedMain.balance, 0n);
  });
});

