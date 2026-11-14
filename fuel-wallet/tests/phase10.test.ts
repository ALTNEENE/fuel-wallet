import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { demoReset } from '../scripts/demo-reset.js';
import {
  runReconciliation,
  updateBankGatewayStatus,
} from '../src/controllers/admin.controller.js';
import { createPayment } from '../src/controllers/payments.controller.js';
import {
  listStations,
  type StationDto,
} from '../src/controllers/stations.controller.js';
import { createTopup } from '../src/controllers/topups.controller.js';
import {
  getWalletLedger,
  listTransactions,
  type TransactionHistoryItemDto,
  type WalletLedgerEntryDto,
} from '../src/controllers/transactions.controller.js';
import { createTransfer } from '../src/controllers/transfers.controller.js';
import { prisma } from '../src/db/prisma.js';
import { AppError } from '../src/errors/app-error.js';
import { TransactionStatus } from '../src/generated/prisma/client.js';
import { ensureUserByClerkId } from '../src/middleware/ensure-user.js';
import type { TransactionDto } from '../src/repositories/transaction.repository.js';
import type { ReconciliationReport } from '../src/services/reconcile.service.js';

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

describe('Phase 10: Hardening, demo-reset, end-to-end demo flow, and concurrency invariants', () => {
  after(async () => {
    await demoReset();

    if (createdClerkIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { clerkUserId: { in: createdClerkIds } },
        select: { id: true },
      });
      const userIds = users.map((u) => u.id);
      if (userIds.length > 0) {
        await prisma.wallet.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: userIds } },
        });
      }
    }
  });

  it('Refuses demo-reset in production, then runs the full demo flow, opposite transfers, 4-of-10 parallel payments, and reconciles ok:true from a freshly reset DB', async () => {
    // 1. Verify demoReset refuses NODE_ENV=production
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(
        async () => {
          await demoReset();
        },
        (err: unknown) =>
          err instanceof Error && err.message.includes('NODE_ENV=production'),
      );
    } finally {
      process.env.NODE_ENV = prevEnv;
    }

    // 2. Run demoReset() to start from a freshly reset DB
    await demoReset();

    // 3. Provision driver and admin users
    const driverClerkId = `clerk_p10_drv_${randomUUID()}`;
    const adminClerkId = `clerk_p10_adm_${randomUUID()}`;
    createdClerkIds.push(driverClerkId, adminClerkId);

    const driver = await ensureUserByClerkId(driverClerkId, async () => ({
      fullName: 'سائق العرض التوضيحي',
      phone: '+249911112222',
    }));
    const admin = await ensureUserByClerkId(adminClerkId, async () => ({
      fullName: 'مدير النظام',
      phone: null,
    }));
    await prisma.user.update({
      where: { id: admin.id },
      data: { role: 'ADMIN' },
    });
    const adminUser = {
      id: admin.id,
      role: 'ADMIN' as const,
      status: 'ACTIVE' as const,
    };

    // 4. Demo Step 1: Top-up 30,000 SDG (plus test idempotency replay & mismatch)
    const topupKey = `idem_demo_topup_${randomUUID()}`;
    const topupMock = createMockRes();
    await createTopup(
      {
        user: driver,
        idempotencyKey: topupKey,
        body: { amount: 30_000 },
      } as unknown as Request,
      topupMock.res,
    );
    assert.equal(topupMock.getStatus(), 201);
    const topupDto = topupMock.getBody().data as TransactionDto;
    assert.equal(topupDto.status, 'COMPLETED');
    assert.equal(topupDto.reference, 'TX-000001');
    assert.equal(topupDto.toBalanceAfter, 30_000);
    const mainWalletId = topupDto.toWalletId;

    // Idempotency replay with same key & same payload returns identical transaction
    const replayMock = createMockRes();
    await createTopup(
      {
        user: driver,
        idempotencyKey: topupKey,
        body: { amount: 30_000 },
      } as unknown as Request,
      replayMock.res,
    );
    assert.equal(replayMock.getStatus(), 200);
    assert.equal((replayMock.getBody().data as TransactionDto).id, topupDto.id);

    // Idempotency mismatch (same key, different payload) -> 422 IDEMPOTENCY_KEY_REUSED
    await assert.rejects(
      async () => {
        await createTopup(
          {
            user: driver,
            idempotencyKey: topupKey,
            body: { amount: 15_000 },
          } as unknown as Request,
          createMockRes().res,
        );
      },
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'IDEMPOTENCY_KEY_REUSED' &&
        err.httpStatus === 422,
    );

    // 5. Demo Step 2: Pick stations via GET /api/stations
    const stationsMock = createMockRes();
    await listStations(
      {
        user: driver,
        query: {},
      } as unknown as Request,
      stationsMock.res,
    );
    assert.equal(stationsMock.getStatus(), 200);
    const stations = (stationsMock.getBody().data as StationDto[]).filter(
      (s) => s.isActive,
    );
    assert.ok(stations.length >= 2, 'Expected at least 2 active seeded stations');
    const stationA = stations[0]!;
    const stationB = stations[1]!;

    // 6. Demo Step 3: Transfer Main -> Station A (20,000 SDG)
    const txMainToAMock = createMockRes();
    await createTransfer(
      {
        user: driver,
        idempotencyKey: `idem_demo_m2a_${randomUUID()}`,
        body: {
          fromWalletId: mainWalletId,
          to: { type: 'STATION', stationId: stationA.id },
          amount: 20_000,
        },
      } as unknown as Request,
      txMainToAMock.res,
    );
    assert.equal(txMainToAMock.getStatus(), 201);
    const txMainToA = txMainToAMock.getBody().data as TransactionDto;
    assert.equal(txMainToA.fromBalanceAfter, 10_000);
    assert.equal(txMainToA.toBalanceAfter, 20_000);
    const stationAWalletId = txMainToA.toWalletId;

    // 7. Demo Step 4: Pay at Station A (12,000 SDG -> leaves 8,000 at Station A)
    const payAMock = createMockRes();
    await createPayment(
      {
        user: driver,
        idempotencyKey: `idem_demo_payA_${randomUUID()}`,
        body: {
          stationId: stationA.id,
          sourceWalletId: stationAWalletId,
          amount: 12_000,
        },
      } as unknown as Request,
      payAMock.res,
    );
    assert.equal(payAMock.getStatus(), 201);
    const payADto = payAMock.getBody().data as TransactionDto;
    assert.equal(payADto.fromBalanceAfter, 8_000);
    assert.equal(payADto.toBalanceAfter, 12_000);
    assert.match(payADto.verificationCode ?? '', /^\d{6}$/);

    // 8. Demo Step 5: Transfer Station A -> Station B (8,000 SDG -> leaves 0 at A, 8,000 at B)
    const txAToBMock = createMockRes();
    await createTransfer(
      {
        user: driver,
        idempotencyKey: `idem_demo_a2b_${randomUUID()}`,
        body: {
          fromWalletId: stationAWalletId,
          to: { type: 'STATION', stationId: stationB.id },
          amount: 8_000,
        },
      } as unknown as Request,
      txAToBMock.res,
    );
    assert.equal(txAToBMock.getStatus(), 201);
    const txAToB = txAToBMock.getBody().data as TransactionDto;
    assert.equal(txAToB.fromBalanceAfter, 0);
    assert.equal(txAToB.toBalanceAfter, 8_000);
    const stationBWalletId = txAToB.toWalletId;

    // 9. Demo Step 6: Pay at Station B (5,000 SDG -> leaves 3,000 at B)
    const payBMock = createMockRes();
    await createPayment(
      {
        user: driver,
        idempotencyKey: `idem_demo_payB1_${randomUUID()}`,
        body: {
          stationId: stationB.id,
          sourceWalletId: stationBWalletId,
          amount: 5_000,
        },
      } as unknown as Request,
      payBMock.res,
    );
    assert.equal(payBMock.getStatus(), 201);
    const payBDto = payBMock.getBody().data as TransactionDto;
    assert.equal(payBDto.fromBalanceAfter, 3_000);
    assert.equal(payBDto.toBalanceAfter, 5_000);

    // 10. Demo Step 7: History & Wallet Ledger Statement
    const historyMock = createMockRes();
    await listTransactions(
      {
        user: driver,
        query: { limit: '20' },
      } as unknown as Request,
      historyMock.res,
    );
    assert.equal(historyMock.getStatus(), 200);
    const historyData = historyMock.getBody().data as {
      items: TransactionHistoryItemDto[];
      nextCursor: string | null;
    };
    assert.equal(historyData.items.length, 5);

    const ledgerMock = createMockRes();
    await getWalletLedger(
      {
        user: driver,
        params: { id: mainWalletId },
        query: { limit: '20' },
      } as unknown as Request,
      ledgerMock.res,
    );
    assert.equal(ledgerMock.getStatus(), 200);
    const ledgerData = ledgerMock.getBody().data as {
      items: WalletLedgerEntryDto[];
      nextCursor: string | null;
    };
    assert.equal(ledgerData.items.length, 2);

    // 11. Demo Step 8: Bank DOWN -> Top-up fails (zero ledger rows), Transfer & Payment still work!
    const bankDownMock = createMockRes();
    await updateBankGatewayStatus(
      {
        user: adminUser,
        body: { status: 'DOWN' },
      } as unknown as Request,
      bankDownMock.res,
    );
    assert.equal(bankDownMock.getStatus(), 200);

    const failedTopupKey = `idem_demo_fail_topup_${randomUUID()}`;
    await assert.rejects(
      async () => {
        await createTopup(
          {
            user: driver,
            idempotencyKey: failedTopupKey,
            body: { amount: 5_000 },
          } as unknown as Request,
          createMockRes().res,
        );
      },
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'BANK_UNAVAILABLE' &&
        err.httpStatus === 503,
    );

    // Verify failed transaction has zero ledger entries
    const failedTxn = await prisma.transaction.findFirst({
      where: { userId: driver.id, idempotencyKey: failedTopupKey },
      include: { ledgerEntries: true },
    });
    assert.ok(failedTxn);
    assert.equal(failedTxn.status, TransactionStatus.FAILED);
    assert.equal(failedTxn.ledgerEntries.length, 0);

    // Transfer works while bank is DOWN (move 2,000 from Main -> Station A)
    const transferWhileBankDownMock = createMockRes();
    await createTransfer(
      {
        user: driver,
        idempotencyKey: `idem_demo_down_tx_${randomUUID()}`,
        body: {
          fromWalletId: mainWalletId,
          to: { type: 'STATION', stationId: stationA.id },
          amount: 2_000,
        },
      } as unknown as Request,
      transferWhileBankDownMock.res,
    );
    assert.equal(transferWhileBankDownMock.getStatus(), 201);

    // Payment works while bank is DOWN (pay remaining 3,000 at Station B)
    const payWhileBankDownMock = createMockRes();
    await createPayment(
      {
        user: driver,
        idempotencyKey: `idem_demo_down_pay_${randomUUID()}`,
        body: {
          stationId: stationB.id,
          sourceWalletId: stationBWalletId,
          amount: 3_000,
        },
      } as unknown as Request,
      payWhileBankDownMock.res,
    );
    assert.equal(payWhileBankDownMock.getStatus(), 201);
    assert.equal(
      (payWhileBankDownMock.getBody().data as TransactionDto).fromBalanceAfter,
      0,
    );

    // Restore bank to UP
    await updateBankGatewayStatus(
      {
        user: adminUser,
        body: { status: 'UP' },
      } as unknown as Request,
      createMockRes().res,
    );

    // 12. Opposite transfers in parallel (Station A <-> Station B without deadlock)
    // Fund Station B with 2,000 from Main so both Station A (2,000) and Station B (2,000) have funds
    await createTransfer(
      {
        user: driver,
        idempotencyKey: `idem_demo_fundB_${randomUUID()}`,
        body: {
          fromWalletId: mainWalletId,
          to: { type: 'STATION', stationId: stationB.id },
          amount: 2_000,
        },
      } as unknown as Request,
      createMockRes().res,
    );

    const [opp1, opp2] = await Promise.all([
      (async () => {
        const m = createMockRes();
        await createTransfer(
          {
            user: driver,
            idempotencyKey: `idem_demo_opp_ab_${randomUUID()}`,
            body: {
              fromWalletId: stationAWalletId,
              to: { type: 'STATION', stationId: stationB.id },
              amount: 1_000,
            },
          } as unknown as Request,
          m.res,
        );
        return m.getStatus();
      })(),
      (async () => {
        const m = createMockRes();
        await createTransfer(
          {
            user: driver,
            idempotencyKey: `idem_demo_opp_ba_${randomUUID()}`,
            body: {
              fromWalletId: stationBWalletId,
              to: { type: 'STATION', stationId: stationA.id },
              amount: 1_000,
            },
          } as unknown as Request,
          m.res,
        );
        return m.getStatus();
      })(),
    ]);
    assert.equal(opp1, 201);
    assert.equal(opp2, 201);

    // 13. Concurrency: 10 parallel payments of 10,000 against a 40,000 balance -> 4 succeed, 6 fail
    // Currently Main Wallet has 6,000; top up 34,000 so Main Wallet has exactly 40,000
    await createTopup(
      {
        user: driver,
        idempotencyKey: `idem_demo_topup_conc_${randomUUID()}`,
        body: { amount: 34_000 },
      } as unknown as Request,
      createMockRes().res,
    );

    const parallelResults = await Promise.allSettled(
      Array.from({ length: 10 }, (_, idx) => {
        const m = createMockRes();
        return createPayment(
          {
            user: driver,
            idempotencyKey: `idem_demo_10par_${idx}_${randomUUID()}`,
            body: {
              stationId: stationA.id,
              sourceWalletId: mainWalletId,
              amount: 10_000,
            },
          } as unknown as Request,
          m.res,
        ).then(() => m.getBody().data as TransactionDto);
      }),
    );

    const fulfilled = parallelResults.filter((r) => r.status === 'fulfilled');
    const rejected = parallelResults.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    for (const r of rejected) {
      if (!(r.reason instanceof AppError && r.reason.code === 'INSUFFICIENT_FUNDS')) {
        console.error('Unexpected rejection in 10-parallel-payments:', r.reason);
      }
    }
    assert.equal(fulfilled.length, 4, 'Expected exactly 4 of 10 parallel payments to succeed');
    assert.equal(rejected.length, 6, 'Expected 6 of 10 parallel payments to fail with INSUFFICIENT_FUNDS');

    // 14. Demo Step 9: Admin Reconciliation returns ok: true and issues: []
    const reconMock = createMockRes();
    await runReconciliation(
      {
        user: adminUser,
      } as unknown as Request,
      reconMock.res,
    );
    assert.equal(reconMock.getStatus(), 200);
    const reconReport = reconMock.getBody().data as ReconciliationReport;
    assert.equal(reconReport.ok, true);
    assert.deepEqual(reconReport.issues, []);
  });
});

