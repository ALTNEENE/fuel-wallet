import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  getOperatorSummary,
  listOperatorPayments,
  lookupOperatorPayment,
  maskPayerName,
  type OperatorPaymentDto,
  type OperatorSummaryDto,
  updateStationCongestion,
} from '../src/controllers/operator.controller.js';
import { createPayment } from '../src/controllers/payments.controller.js';
import {
  getStationById,
  listStations,
  type StationDto,
} from '../src/controllers/stations.controller.js';
import { createTopup } from '../src/controllers/topups.controller.js';
import { prisma } from '../src/db/prisma.js';
import { AppError } from '../src/errors/app-error.js';
import {
  TransactionStatus,
  TransactionType,
  WalletType,
} from '../src/generated/prisma/client.js';
import { ensureUserByClerkId } from '../src/middleware/ensure-user.js';
import type { TransactionDto } from '../src/repositories/transaction.repository.js';
import { bankSimulatorService } from '../src/services/bank-simulator.service.js';
import { reconcileService } from '../src/services/reconcile.service.js';

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

describe('Phase 9: Operator tools (innovation)', () => {
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
      await prisma.wallet.deleteMany({
        where: { stationId: { in: tempStationIds } },
      });
      await prisma.station.deleteMany({
        where: { id: { in: tempStationIds } },
      });
    }
  });

  it('Scopes operator payments, 30-min code lookup, daily summary, and station congestion strictly to their station', async () => {
    await bankSimulatorService.setStatus('UP');

    // 1. Create two isolated stations (Station A and Station B) with STATION_REVENUE wallets
    const stationA = await prisma.station.create({
      data: {
        name: `محطة مشغل أ ${randomUUID().slice(0, 6)}`,
        city: 'الخرطوم',
        address: 'شارع المطار',
        isActive: true,
        congestion: 'LOW',
      },
    });
    tempStationIds.push(stationA.id);
    await prisma.wallet.create({
      data: {
        type: WalletType.STATION_REVENUE,
        stationId: stationA.id,
        balance: 0n,
      },
    });

    const stationB = await prisma.station.create({
      data: {
        name: `محطة مشغل ب ${randomUUID().slice(0, 6)}`,
        city: 'أم درمان',
        address: 'شارع الثورة',
        isActive: true,
        congestion: 'LOW',
      },
    });
    tempStationIds.push(stationB.id);
    await prisma.wallet.create({
      data: {
        type: WalletType.STATION_REVENUE,
        stationId: stationB.id,
        balance: 0n,
      },
    });

    // 2. Create driver, operatorA, operatorB, and admin users
    const driverClerkId = `clerk_p9_drv_${randomUUID()}`;
    const opAClerkId = `clerk_p9_opa_${randomUUID()}`;
    const opBClerkId = `clerk_p9_opb_${randomUUID()}`;
    const adminClerkId = `clerk_p9_adm_${randomUUID()}`;
    createdClerkIds.push(driverClerkId, opAClerkId, opBClerkId, adminClerkId);

    const driver = await ensureUserByClerkId(driverClerkId, async () => ({
      fullName: 'أحمد المنصور',
      phone: '+249912345678',
    }));
    const opA = await ensureUserByClerkId(opAClerkId, async () => ({
      fullName: 'Operator A',
      phone: null,
    }));
    const opB = await ensureUserByClerkId(opBClerkId, async () => ({
      fullName: 'Operator B',
      phone: null,
    }));
    const admin = await ensureUserByClerkId(adminClerkId, async () => ({
      fullName: 'System Admin',
      phone: null,
    }));

    await prisma.user.update({
      where: { id: opA.id },
      data: { role: 'OPERATOR', operatorStationId: stationA.id },
    });
    await prisma.user.update({
      where: { id: opB.id },
      data: { role: 'OPERATOR', operatorStationId: stationB.id },
    });
    await prisma.user.update({
      where: { id: admin.id },
      data: { role: 'ADMIN' },
    });

    const opAUser = {
      id: opA.id,
      role: 'OPERATOR' as const,
      status: 'ACTIVE' as const,
      operatorStationId: stationA.id,
    };
    const opBUser = {
      id: opB.id,
      role: 'OPERATOR' as const,
      status: 'ACTIVE' as const,
      operatorStationId: stationB.id,
    };
    const adminUser = {
      id: admin.id,
      role: 'ADMIN' as const,
      status: 'ACTIVE' as const,
      operatorStationId: null,
    };

    // 3. Top up driver with 40,000 SDG
    const topupMock = createMockRes();
    await createTopup(
      {
        user: driver,
        idempotencyKey: `idem_p9_topup_${randomUUID()}`,
        body: { amount: 40_000 },
      } as unknown as Request,
      topupMock.res,
    );
    assert.equal(topupMock.getStatus(), 201);
    const mainWalletId = (topupMock.getBody().data as TransactionDto).toWalletId;

    // 4. Driver makes 2 payments at Station A (5,000 and 7,000) and 1 payment at Station B (6,000)
    const payA1Mock = createMockRes();
    await createPayment(
      {
        user: driver,
        idempotencyKey: `idem_p9_pA1_${randomUUID()}`,
        body: {
          stationId: stationA.id,
          sourceWalletId: mainWalletId,
          amount: 5_000,
        },
      } as unknown as Request,
      payA1Mock.res,
    );
    assert.equal(payA1Mock.getStatus(), 201);
    const payA1 = payA1Mock.getBody().data as TransactionDto;
    assert.ok(payA1.verificationCode);

    const payA2Mock = createMockRes();
    await createPayment(
      {
        user: driver,
        idempotencyKey: `idem_p9_pA2_${randomUUID()}`,
        body: {
          stationId: stationA.id,
          sourceWalletId: mainWalletId,
          amount: 7_000,
        },
      } as unknown as Request,
      payA2Mock.res,
    );
    assert.equal(payA2Mock.getStatus(), 201);
    const payA2 = payA2Mock.getBody().data as TransactionDto;
    assert.ok(payA2.verificationCode);

    const payBMock = createMockRes();
    await createPayment(
      {
        user: driver,
        idempotencyKey: `idem_p9_pB_${randomUUID()}`,
        body: {
          stationId: stationB.id,
          sourceWalletId: mainWalletId,
          amount: 6_000,
        },
      } as unknown as Request,
      payBMock.res,
    );
    assert.equal(payBMock.getStatus(), 201);
    const payB = payBMock.getBody().data as TransactionDto;
    assert.ok(payB.verificationCode);

    // 5. Verify GET /api/operator/payments scoping & cursor pagination
    assert.equal(maskPayerName('أحمد المنصور'), 'أ*** ا***');

    const listAPage1Mock = createMockRes();
    await listOperatorPayments(
      {
        user: opAUser,
        query: { limit: '1' },
      } as unknown as Request,
      listAPage1Mock.res,
    );
    assert.equal(listAPage1Mock.getStatus(), 200);
    const page1 = listAPage1Mock.getBody().data as {
      items: OperatorPaymentDto[];
      nextCursor: string | null;
    };
    assert.equal(page1.items.length, 1);
    assert.equal(page1.items[0]?.id, payA2.id);
    assert.equal(page1.items[0]?.amount, 7_000);
    assert.equal(page1.items[0]?.verificationCode, payA2.verificationCode);
    assert.equal(page1.items[0]?.payerName, 'أ*** ا***');
    assert.notEqual(page1.items[0]?.payerName, 'أحمد المنصور');
    assert.ok(page1.nextCursor);

    const listAPage2Mock = createMockRes();
    await listOperatorPayments(
      {
        user: opAUser,
        query: { limit: '1', cursor: page1.nextCursor },
      } as unknown as Request,
      listAPage2Mock.res,
    );
    assert.equal(listAPage2Mock.getStatus(), 200);
    const page2 = listAPage2Mock.getBody().data as {
      items: OperatorPaymentDto[];
      nextCursor: string | null;
    };
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0]?.id, payA1.id);
    assert.equal(page2.items[0]?.amount, 5_000);
    assert.equal(page2.nextCursor, null);

    // Operator B sees ONLY Station B's payment (6,000), never Station A's payments
    const listBMock = createMockRes();
    await listOperatorPayments(
      {
        user: opBUser,
        query: {},
      } as unknown as Request,
      listBMock.res,
    );
    assert.equal(listBMock.getStatus(), 200);
    const listB = listBMock.getBody().data as {
      items: OperatorPaymentDto[];
      nextCursor: string | null;
    };
    assert.equal(listB.items.length, 1);
    assert.equal(listB.items[0]?.id, payB.id);
    assert.equal(listB.items[0]?.amount, 6_000);

    // Operator A attempting to query Station B via ?stationId= is FORBIDDEN (403)
    await assert.rejects(
      async () => {
        await listOperatorPayments(
          {
            user: opAUser,
            query: { stationId: stationB.id },
          } as unknown as Request,
          createMockRes().res,
        );
      },
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'FORBIDDEN' &&
        err.httpStatus === 403,
    );

    // 6. Verify GET /api/operator/payments/lookup?code=123456
    // 6a. Lookup valid code at Station A within 30 minutes succeeds for Operator A
    const lookupOkMock = createMockRes();
    await lookupOperatorPayment(
      {
        user: opAUser,
        query: { code: payA2.verificationCode! },
      } as unknown as Request,
      lookupOkMock.res,
    );
    assert.equal(lookupOkMock.getStatus(), 200);
    const lookedUp = lookupOkMock.getBody().data as OperatorPaymentDto;
    assert.equal(lookedUp.id, payA2.id);
    assert.equal(lookedUp.amount, 7_000);
    assert.equal(lookedUp.verificationCode, payA2.verificationCode);

    // 6b. Operator B looking up Station A's code gets 404 NOT_FOUND
    await assert.rejects(
      async () => {
        await lookupOperatorPayment(
          {
            user: opBUser,
            query: { code: payA2.verificationCode! },
          } as unknown as Request,
          createMockRes().res,
        );
      },
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'NOT_FOUND' &&
        err.httpStatus === 404,
    );

    // 6c. Operator A looking up Station B's code gets 404 NOT_FOUND
    await assert.rejects(
      async () => {
        await lookupOperatorPayment(
          {
            user: opAUser,
            query: { code: payB.verificationCode! },
          } as unknown as Request,
          createMockRes().res,
        );
      },
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'NOT_FOUND' &&
        err.httpStatus === 404,
    );

    // 6d. Age payA1 to 31 minutes ago -> lookup at Station A returns 404 NOT_FOUND
    await prisma.$executeRaw`
      UPDATE "transactions"
      SET "created_at" = NOW() - INTERVAL '31 minutes'
      WHERE "id" = ${payA1.id}::uuid
    `;

    await assert.rejects(
      async () => {
        await lookupOperatorPayment(
          {
            user: opAUser,
            query: { code: payA1.verificationCode! },
          } as unknown as Request,
          createMockRes().res,
        );
      },
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'NOT_FOUND' &&
        err.httpStatus === 404,
    );

    // 7. Verify GET /api/operator/summary (today's total amount and payment count)
    // Age payA1 to 2 days ago so only payA2 (7,000) is from today
    await prisma.$executeRaw`
      UPDATE "transactions"
      SET "created_at" = NOW() - INTERVAL '2 days'
      WHERE "id" = ${payA1.id}::uuid
    `;

    const summaryAMock = createMockRes();
    await getOperatorSummary(
      {
        user: opAUser,
        query: {},
      } as unknown as Request,
      summaryAMock.res,
    );
    assert.equal(summaryAMock.getStatus(), 200);
    const summaryA = summaryAMock.getBody().data as OperatorSummaryDto;
    assert.equal(summaryA.stationId, stationA.id);
    assert.equal(summaryA.totalAmount, 7_000);
    assert.equal(summaryA.paymentCount, 1);
    assert.equal(summaryA.revenueBalance, 12_000);

    // Admin can query Station B's summary via ?stationId=
    const summaryBAdminMock = createMockRes();
    await getOperatorSummary(
      {
        user: adminUser,
        query: { stationId: stationB.id },
      } as unknown as Request,
      summaryBAdminMock.res,
    );
    assert.equal(summaryBAdminMock.getStatus(), 200);
    const summaryB = summaryBAdminMock.getBody().data as OperatorSummaryDto;
    assert.equal(summaryB.stationId, stationB.id);
    assert.equal(summaryB.totalAmount, 6_000);
    assert.equal(summaryB.paymentCount, 1);

    // 8. Verify PATCH /api/operator/station { congestion: 'HIGH' } reflects in GET /api/stations
    const patchCongestionMock = createMockRes();
    await updateStationCongestion(
      {
        user: opAUser,
        query: {},
        body: { congestion: 'HIGH' },
      } as unknown as Request,
      patchCongestionMock.res,
    );
    assert.equal(patchCongestionMock.getStatus(), 200);

    // Check GET /api/stations/:id and GET /api/stations
    const getStationAMock = createMockRes();
    await getStationById(
      {
        user: driver,
        params: { id: stationA.id },
      } as unknown as Request,
      getStationAMock.res,
    );
    assert.equal(getStationAMock.getStatus(), 200);
    const stationADto = getStationAMock.getBody().data as StationDto;
    assert.equal(stationADto.congestion, 'HIGH');

    const listStationsMock = createMockRes();
    await listStations(
      {
        user: driver,
        query: {},
      } as unknown as Request,
      listStationsMock.res,
    );
    assert.equal(listStationsMock.getStatus(), 200);
    const allStations = listStationsMock.getBody().data as StationDto[];
    const foundA = allStations.find((s) => s.id === stationA.id);
    const foundB = allStations.find((s) => s.id === stationB.id);
    assert.equal(foundA?.congestion, 'HIGH');
    assert.equal(foundB?.congestion, 'LOW');

    // 9. Verify ledger reconciliation remains ok: true
    const reconReport = await reconcileService.reconcile();
    assert.equal(reconReport.ok, true);
    assert.equal(reconReport.issues.length, 0);
  });
});

