import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { prisma } from '../src/db/prisma.js';
import { AppError } from '../src/errors/app-error.js';
import {
  TransactionStatus,
  TransactionType,
  WalletType,
} from '../src/generated/prisma/client.js';
import {
  isReplayedDto,
  transactionRepository,
} from '../src/repositories/transaction.repository.js';
import {
  type ResolvedTransaction,
  TransactionService,
} from '../src/services/transaction.service.js';

interface TestMoveInput {
  fromWalletId: string;
  toWalletId: string;
  amount: bigint;
}

class MinimalTestTransactionService extends TransactionService<TestMoveInput> {
  private readonly txnType: TransactionType;

  constructor(txnType: TransactionType = TransactionType.PAYMENT) {
    super();
    this.txnType = txnType;
  }

  override type(): TransactionType {
    return this.txnType;
  }

  override async resolve(
    _userId: string,
    input: TestMoveInput,
  ): Promise<ResolvedTransaction> {
    return {
      fromWalletId: input.fromWalletId,
      toWalletId: input.toWalletId,
      amount: input.amount,
    };
  }
}

const createdUserIds: string[] = [];
const createdWalletIds: string[] = [];

describe('Phase 3: Transaction engine (LedgerService, TransactionRepository, TransactionService)', () => {
  after(async () => {
    if (createdUserIds.length > 0 || createdWalletIds.length > 0) {
      const txns = await prisma.transaction.findMany({
        where: {
          OR: [
            { userId: { in: createdUserIds } },
            { fromWalletId: { in: createdWalletIds } },
            { toWalletId: { in: createdWalletIds } },
          ],
        },
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

      if (createdWalletIds.length > 0) {
        await prisma.wallet.deleteMany({
          where: { id: { in: createdWalletIds } },
        });
      }

      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({
          where: { id: { in: createdUserIds } },
        });
      }
    }

    await prisma.$disconnect();
  });

  it('(a) 10 parallel 5000 payments from a wallet holding 20000 -> 4 COMPLETED, 6 FAILED INSUFFICIENT_FUNDS, balance 0, 8 ledger rows', async () => {
    const user = await prisma.user.create({
      data: {
        clerkUserId: `user_phase3_a_${randomUUID()}`,
        fullName: 'اختبار التوازي',
      },
    });
    createdUserIds.push(user.id);

    const station = await prisma.station.findFirstOrThrow();

    const fromWallet = await prisma.wallet.create({
      data: {
        type: WalletType.USER_MAIN,
        userId: user.id,
        balance: 20000n,
      },
    });
    const toWallet = await prisma.wallet.create({
      data: {
        type: WalletType.USER_STATION,
        userId: user.id,
        stationId: station.id,
        balance: 0n,
      },
    });
    createdWalletIds.push(fromWallet.id, toWallet.id);

    const service = new MinimalTestTransactionService(TransactionType.PAYMENT);
    const keys = Array.from(
      { length: 10 },
      (_, idx) => `p3a-key-${idx}-${randomUUID().slice(0, 8)}`,
    );

    const outcomes = await Promise.allSettled(
      keys.map((key) =>
        service.execute(
          { id: user.id, role: user.role, status: user.status },
          {
            fromWalletId: fromWallet.id,
            toWalletId: toWallet.id,
            amount: 5000n,
          },
          key,
        ),
      ),
    );

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );

    assert.equal(fulfilled.length, 4, 'Expected exactly 4 completed payments');
    assert.equal(rejected.length, 6, 'Expected exactly 6 failed payments');

    for (const r of rejected) {
      assert.ok(r.reason instanceof AppError);
      assert.equal(r.reason.code, 'INSUFFICIENT_FUNDS');
      assert.equal(r.reason.httpStatus, 422);
    }

    const dbTxns = await prisma.transaction.findMany({
      where: { userId: user.id },
    });
    assert.equal(dbTxns.length, 10);
    assert.equal(
      dbTxns.filter((t) => t.status === TransactionStatus.COMPLETED).length,
      4,
    );
    assert.equal(
      dbTxns.filter(
        (t) =>
          t.status === TransactionStatus.FAILED &&
          t.failureCode === 'INSUFFICIENT_FUNDS',
      ).length,
      6,
    );

    const updatedFrom = await prisma.wallet.findUniqueOrThrow({
      where: { id: fromWallet.id },
    });
    const updatedTo = await prisma.wallet.findUniqueOrThrow({
      where: { id: toWallet.id },
    });
    assert.equal(updatedFrom.balance, 0n);
    assert.equal(updatedTo.balance, 20000n);

    const ledgerCount = await prisma.ledgerEntry.count({
      where: {
        walletId: { in: [fromWallet.id, toWallet.id] },
      },
    });
    assert.equal(ledgerCount, 8, 'Expected exactly 8 ledger rows (2 per completed txn)');
  });

  it('(b) concurrent A->B and B->A transfers finish without deadlock', async () => {
    const user = await prisma.user.create({
      data: {
        clerkUserId: `user_phase3_b_${randomUUID()}`,
        fullName: 'اختبار عدم التوقف التبادلي',
      },
    });
    createdUserIds.push(user.id);

    const stations = await prisma.station.findMany({ take: 2 });
    assert.equal(stations.length, 2);

    const walletA = await prisma.wallet.create({
      data: {
        type: WalletType.USER_STATION,
        userId: user.id,
        stationId: stations[0]!.id,
        balance: 10000n,
      },
    });
    const walletB = await prisma.wallet.create({
      data: {
        type: WalletType.USER_STATION,
        userId: user.id,
        stationId: stations[1]!.id,
        balance: 10000n,
      },
    });
    createdWalletIds.push(walletA.id, walletB.id);

    const service = new MinimalTestTransactionService(TransactionType.TRANSFER);

    // Run 6 concurrent transfers (3 A->B and 3 B->A interleaved)
    const tasks = Array.from({ length: 6 }, (_, i) => {
      const isAtoB = i % 2 === 0;
      return service.execute(
        { id: user.id, role: user.role, status: user.status },
        {
          fromWalletId: isAtoB ? walletA.id : walletB.id,
          toWalletId: isAtoB ? walletB.id : walletA.id,
          amount: 1000n,
        },
        `p3b-key-${i}-${randomUUID().slice(0, 8)}`,
      );
    });

    const results = await Promise.all(tasks);
    assert.equal(results.length, 6);
    assert.ok(results.every((r) => r.status === TransactionStatus.COMPLETED));

    const finalA = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletA.id },
    });
    const finalB = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletB.id },
    });
    assert.equal(finalA.balance, 10000n);
    assert.equal(finalB.balance, 10000n);
  });

  it('(c) same idempotency key twice -> one txn row, one pair of ledger entries, identical DTO; and (d) different amount -> IDEMPOTENCY_KEY_REUSED', async () => {
    const user = await prisma.user.create({
      data: {
        clerkUserId: `user_phase3_cd_${randomUUID()}`,
        fullName: 'اختبار عدم التكرار',
      },
    });
    createdUserIds.push(user.id);

    const station = await prisma.station.findFirstOrThrow();

    const fromWallet = await prisma.wallet.create({
      data: {
        type: WalletType.USER_MAIN,
        userId: user.id,
        balance: 10000n,
      },
    });
    const toWallet = await prisma.wallet.create({
      data: {
        type: WalletType.USER_STATION,
        userId: user.id,
        stationId: station.id,
        balance: 0n,
      },
    });
    createdWalletIds.push(fromWallet.id, toWallet.id);

    const service = new MinimalTestTransactionService(TransactionType.TRANSFER);
    const idempotencyKey = `p3c-idem-${randomUUID().slice(0, 12)}`;

    const dto1 = await service.execute(
      { id: user.id, role: user.role, status: user.status },
      {
        fromWalletId: fromWallet.id,
        toWalletId: toWallet.id,
        amount: 3000n,
      },
      idempotencyKey,
    );

    const dto2 = await service.execute(
      { id: user.id, role: user.role, status: user.status },
      {
        fromWalletId: fromWallet.id,
        toWalletId: toWallet.id,
        amount: 3000n,
      },
      idempotencyKey,
    );

    assert.equal(isReplayedDto(dto1), false);
    assert.equal(isReplayedDto(dto2), true);
    assert.deepEqual(dto1, dto2);
    assert.match(dto1.reference, /^TX-\d{6}$/);
    assert.equal(dto1.balanceAfter.from, 7000);
    assert.equal(dto1.balanceAfter.to, 3000);

    const txnCount = await prisma.transaction.count({
      where: { userId: user.id, idempotencyKey },
    });
    assert.equal(txnCount, 1, 'Expected exactly 1 transaction row');

    const ledgerCount = await prisma.ledgerEntry.count({
      where: { transactionId: dto1.id },
    });
    assert.equal(ledgerCount, 2, 'Expected exactly 1 pair (2 rows) of ledger entries');

    // (d) Same idempotency key with a different amount -> IDEMPOTENCY_KEY_REUSED (422)
    await assert.rejects(
      () =>
        service.execute(
          { id: user.id, role: user.role, status: user.status },
          {
            fromWalletId: fromWallet.id,
            toWalletId: toWallet.id,
            amount: 4500n,
          },
          idempotencyKey,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'IDEMPOTENCY_KEY_REUSED' &&
        err.httpStatus === 422,
    );
  });

  it('(e) a failed move -> txn FAILED, zero ledger rows, balances unchanged', async () => {
    const user = await prisma.user.create({
      data: {
        clerkUserId: `user_phase3_e_${randomUUID()}`,
        fullName: 'اختبار الفشل',
      },
    });
    createdUserIds.push(user.id);

    const station = await prisma.station.findFirstOrThrow();

    const fromWallet = await prisma.wallet.create({
      data: {
        type: WalletType.USER_MAIN,
        userId: user.id,
        balance: 1000n,
      },
    });
    const toWallet = await prisma.wallet.create({
      data: {
        type: WalletType.USER_STATION,
        userId: user.id,
        stationId: station.id,
        balance: 500n,
      },
    });
    createdWalletIds.push(fromWallet.id, toWallet.id);

    const service = new MinimalTestTransactionService(TransactionType.PAYMENT);
    const idempotencyKey = `p3e-fail-${randomUUID().slice(0, 12)}`;

    await assert.rejects(
      () =>
        service.execute(
          { id: user.id, role: user.role, status: user.status },
          {
            fromWalletId: fromWallet.id,
            toWalletId: toWallet.id,
            amount: 5000n,
          },
          idempotencyKey,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'INSUFFICIENT_FUNDS' &&
        err.httpStatus === 422,
    );

    const failedTxn = await transactionRepository.findByKey(
      user.id,
      idempotencyKey,
    );
    assert.ok(failedTxn, 'Failed transaction row must be recorded');
    assert.equal(failedTxn.status, TransactionStatus.FAILED);
    assert.equal(failedTxn.failureCode, 'INSUFFICIENT_FUNDS');
    assert.equal(failedTxn.ledgerEntries.length, 0, 'FAILED txn must have zero ledger entries');

    const afterFrom = await prisma.wallet.findUniqueOrThrow({
      where: { id: fromWallet.id },
    });
    const afterTo = await prisma.wallet.findUniqueOrThrow({
      where: { id: toWallet.id },
    });
    assert.equal(afterFrom.balance, 1000n, 'Source balance must be unchanged');
    assert.equal(afterTo.balance, 500n, 'Destination balance must be unchanged');

    // Replaying the failed transaction key with identical payload must throw the same AppError
    await assert.rejects(
      () =>
        service.execute(
          { id: user.id, role: user.role, status: user.status },
          {
            fromWalletId: fromWallet.id,
            toWalletId: toWallet.id,
            amount: 5000n,
          },
          idempotencyKey,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'INSUFFICIENT_FUNDS' &&
        err.httpStatus === 422,
    );
  });
});

