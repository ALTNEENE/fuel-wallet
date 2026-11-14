import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  getTransactionById,
  getWalletLedger,
  listTransactions,
  type TransactionHistoryItemDto,
  type WalletLedgerEntryDto,
} from '../src/controllers/transactions.controller.js';
import { prisma } from '../src/db/prisma.js';
import { AppError } from '../src/errors/app-error.js';
import { ERROR_CATALOG } from '../src/errors/catalog.js';
import {
  TransactionStatus,
  TransactionType,
} from '../src/generated/prisma/client.js';
import { ensureUserByClerkId } from '../src/middleware/ensure-user.js';
import { walletRepository } from '../src/repositories/wallet.repository.js';
import { sha256 } from '../src/utils/hash.js';

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

describe('Phase 7: History and statements (GET /api/transactions, GET /api/transactions/:id, GET /api/wallets/:id/ledger)', () => {
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
          select: { id: true },
        });
        const txnIds = txns.map((t) => t.id);

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

  it('Stable cursor pagination across 55 rows including identical timestamps, Arabic failureMessage on FAILED items, and no N+1 queries', async () => {
    const clerkUser1 = `user_phase7_u1_${randomUUID()}`;
    const clerkUser2 = `user_phase7_u2_${randomUUID()}`;
    createdClerkIds.push(clerkUser1, clerkUser2);

    const user1 = await ensureUserByClerkId(clerkUser1, async () => ({
      fullName: 'مستخدم السجل 1',
      phone: null,
    }));
    const user2 = await ensureUserByClerkId(clerkUser2, async () => ({
      fullName: 'مستخدم السجل 2',
      phone: null,
    }));

    const mainWallet1 = await walletRepository.getMainWallet(user1.id);
    const mainWallet2 = await walletRepository.getMainWallet(user2.id);

    const station = await prisma.station.findFirstOrThrow({
      where: { isActive: true },
    });
    const stationWallet1 = await walletRepository.ensureStationWallet(
      user1.id,
      station.id,
    );
    const revenueWallet = await walletRepository.getRevenueWallet(station.id);

    // Insert 55 transactions for user1 (including 25 with identical timestamp) + 1 transaction for user2
    const identicalTimestamp = new Date('2026-11-14T10:00:00.000Z');
    const txnPayloads = Array.from({ length: 55 }, (_, i) => {
      const isIdenticalTime = i < 25;
      const createdAt = isIdenticalTime
        ? identicalTimestamp
        : new Date(identicalTimestamp.getTime() + (i - 24) * 1000);

      const isFailed = i % 5 === 0;
      const isPending = i === 54;
      const status = isPending
        ? TransactionStatus.PENDING
        : isFailed
          ? TransactionStatus.FAILED
          : TransactionStatus.COMPLETED;

      const isPayment = i % 2 === 0;
      const type = isPayment ? TransactionType.PAYMENT : TransactionType.TRANSFER;
      const fromWalletId = mainWallet1.id;
      const toWalletId = isPayment ? revenueWallet.id : stationWallet1.id;

      return {
        id: randomUUID(),
        type,
        status,
        userId: user1.id,
        fromWalletId,
        toWalletId,
        amount: BigInt(1000 + i * 100),
        idempotencyKey: `p7-u1-tx-${i}-${randomUUID().slice(0, 8)}`,
        requestHash: sha256(`p7-${i}`),
        failureCode: isFailed ? 'INSUFFICIENT_FUNDS' : null,
        failureReason: isFailed ? ERROR_CATALOG.INSUFFICIENT_FUNDS.message : null,
        verificationCode: isPayment ? '654321' : null,
        createdAt,
        completedAt: isPending ? null : createdAt,
      };
    });

    await prisma.transaction.createMany({
      data: txnPayloads,
    });

    // Also create a transaction for user2
    const user2Txn = await prisma.transaction.create({
      data: {
        type: TransactionType.TRANSFER,
        status: TransactionStatus.COMPLETED,
        userId: user2.id,
        fromWalletId: mainWallet2.id,
        toWalletId: stationWallet1.id,
        amount: 2000n,
        idempotencyKey: `p7-u2-tx-${randomUUID().slice(0, 8)}`,
        requestHash: sha256('p7-u2'),
      },
    });

    // Paginate through all 55 transactions of user1 in pages of 15
    const collected: TransactionHistoryItemDto[] = [];
    let cursor: string | undefined;
    let pageCount = 0;

    do {
      const mockPage = createMockRes();
      await listTransactions(
        {
          user: { id: user1.id, role: user1.role, status: user1.status },
          query: {
            limit: '15',
            ...(cursor ? { cursor } : {}),
          },
        } as unknown as Request,
        mockPage.res,
      );

      assert.equal(mockPage.getStatus(), 200);
      const pageData = mockPage.getBody().data as {
        items: TransactionHistoryItemDto[];
        nextCursor: string | null;
      };

      collected.push(...pageData.items);
      cursor = pageData.nextCursor ?? undefined;
      pageCount++;
    } while (cursor);

    assert.equal(pageCount, 4, 'Expected 4 pages (15 + 15 + 15 + 10 = 55)');
    assert.equal(collected.length, 55, 'Must return all 55 rows');

    const uniqueIds = new Set(collected.map((item) => item.id));
    assert.equal(uniqueIds.size, 55, 'Zero duplicates across pages');
    assert.equal(
      uniqueIds.has(user2Txn.id),
      false,
      "Must never include another user's transaction",
    );

    // Verify ordering: (createdAt DESC, id DESC)
    for (let i = 1; i < collected.length; i++) {
      const prev = collected[i - 1]!;
      const curr = collected[i]!;
      const prevTime = new Date(prev.createdAt).getTime();
      const currTime = new Date(curr.createdAt).getTime();
      assert.ok(
        prevTime > currTime || (prevTime === currTime && prev.id > curr.id),
        `Broken sort order at index ${i}: (${prev.createdAt}, ${prev.id}) vs (${curr.createdAt}, ${curr.id})`,
      );
    }

    // Verify FAILED items show Arabic failureMessage and null verificationCode
    const failedItems = collected.filter(
      (item) => item.status === TransactionStatus.FAILED,
    );
    assert.ok(failedItems.length > 0);
    for (const f of failedItems) {
      assert.equal(f.failureCode, 'INSUFFICIENT_FUNDS');
      assert.equal(f.failureMessage, ERROR_CATALOG.INSUFFICIENT_FUNDS.message);
      assert.equal(
        f.verificationCode,
        null,
        'FAILED payment must not expose verificationCode',
      );
    }

    // Verify COMPLETED PAYMENT items show verificationCode and stationName
    const completedPayments = collected.filter(
      (item) =>
        item.type === TransactionType.PAYMENT &&
        item.status === TransactionStatus.COMPLETED,
    );
    assert.ok(completedPayments.length > 0);
    for (const cp of completedPayments) {
      assert.equal(cp.verificationCode, '654321');
      assert.equal(cp.to.stationId, station.id);
      assert.equal(cp.to.stationName, station.name);
      assert.equal(cp.failureMessage, null);
    }

    // GET /api/transactions/:id for user1's PENDING transaction succeeds
    const pendingId = txnPayloads[54]!.id;
    const mockGetOwn = createMockRes();
    await getTransactionById(
      {
        user: { id: user1.id, role: user1.role, status: user1.status },
        params: { id: pendingId },
      } as unknown as Request,
      mockGetOwn.res,
    );
    assert.equal(mockGetOwn.getStatus(), 200);
    const singleDto = mockGetOwn.getBody().data as TransactionHistoryItemDto;
    assert.equal(singleDto.id, pendingId);
    assert.equal(singleDto.status, TransactionStatus.PENDING);

    // GET /api/transactions/:id for user2's transaction -> 404 NOT_FOUND
    await assert.rejects(
      () =>
        getTransactionById(
          {
            user: { id: user1.id, role: user1.role, status: user1.status },
            params: { id: user2Txn.id },
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'NOT_FOUND' &&
        err.httpStatus === 404,
    );

    // Wallet statement: GET /api/wallets/:id/ledger
    const completedTxns = txnPayloads.filter(
      (t) => t.status === TransactionStatus.COMPLETED,
    );
    await prisma.ledgerEntry.createMany({
      data: completedTxns.slice(0, 5).map((t, idx) => ({
        transactionId: t.id,
        walletId: mainWallet1.id,
        delta: -t.amount,
        balanceAfter: BigInt(50000 - idx * 1000),
        createdAt: t.createdAt,
      })),
    });

    const mockLedger = createMockRes();
    await getWalletLedger(
      {
        user: { id: user1.id, role: user1.role, status: user1.status },
        params: { id: mainWallet1.id },
        query: { limit: '3' },
      } as unknown as Request,
      mockLedger.res,
    );
    assert.equal(mockLedger.getStatus(), 200);
    const ledgerPage1 = mockLedger.getBody().data as {
      items: WalletLedgerEntryDto[];
      nextCursor: string | null;
    };
    assert.equal(ledgerPage1.items.length, 3);
    assert.ok(ledgerPage1.nextCursor);
    assert.match(ledgerPage1.items[0]!.reference, /^TX-\d{6}$/);
    assert.ok(ledgerPage1.items[0]!.delta < 0);

    // Another user's wallet statement -> 404 NOT_FOUND
    await assert.rejects(
      () =>
        getWalletLedger(
          {
            user: { id: user1.id, role: user1.role, status: user1.status },
            params: { id: mainWallet2.id },
            query: {},
          } as unknown as Request,
          createMockRes().res,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'NOT_FOUND' &&
        err.httpStatus === 404,
    );
  });
});

