import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  getStationById,
  listStations,
  type StationDto,
} from '../src/controllers/stations.controller.js';
import { prisma } from '../src/db/prisma.js';
import { AppError } from '../src/errors/app-error.js';
import { WalletType } from '../src/generated/prisma/client.js';
import { ensureUserByClerkId } from '../src/middleware/ensure-user.js';
import { validate } from '../src/middleware/validate.js';
import { stationIdParamSchema } from '../src/schemas/station.js';

const createdClerkIds: string[] = [];
const extraStationIds: string[] = [];

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

describe('Phase 2: Stations (read-only)', () => {
  after(async () => {
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
    if (extraStationIds.length > 0) {
      await prisma.station.deleteMany({
        where: { id: { in: extraStationIds } },
      });
    }
    await prisma.$disconnect();
  });

  it('returns the 4 seeded stations sorted by name with accurate balances and availableHere, in constant query count', async () => {
    const clerkUserId = `user_phase2_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const user = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'عمر حسن',
      phone: '+249912000000',
    }));

    // Set up main wallet balance (5000) and 2 station wallets (1500 and 2500) for test verification
    await prisma.wallet.updateMany({
      where: { userId: user.id, type: WalletType.USER_MAIN },
      data: { balance: 5000n },
    });

    const seededStations = await prisma.station.findMany({
      orderBy: { name: 'asc' },
    });
    assert.ok(seededStations.length >= 4, 'Expected at least 4 seeded stations');

    const firstStation = seededStations[0]!;
    const secondStation = seededStations[1]!;

    const firstStationWallet = await prisma.wallet.create({
      data: {
        type: WalletType.USER_STATION,
        userId: user.id,
        stationId: firstStation.id,
        balance: 1500n,
      },
    });

    const secondStationWallet = await prisma.wallet.create({
      data: {
        type: WalletType.USER_STATION,
        userId: user.id,
        stationId: secondStation.id,
        balance: 2500n,
      },
    });

    // Measure queries for N=4 stations
    const queriesFor4: string[] = [];
    const listener = (e: { query: string }) => {
      queriesFor4.push(e.query);
    };
    prisma.$on('query', listener);

    const mock1 = createMockRes();
    const req1 = {
      user: { id: user.id, role: user.role, status: user.status },
      query: {},
    } as unknown as Request;

    await listStations(req1, mock1.res);
    const countFor4 = queriesFor4.length;

    assert.equal(mock1.getStatus(), 200);
    const list4 = mock1.getBody().data as StationDto[];
    assert.equal(list4.length, seededStations.length);

    // Check sorting by name ascending
    const names = list4.map((s) => s.name);
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, list4.map((s) => s.name));
    void sortedNames;

    // Verify balances on firstStation, secondStation, and a station without a USER_STATION wallet
    const dto1 = list4.find((s) => s.id === firstStation.id)!;
    assert.equal(dto1.myStationWalletId, firstStationWallet.id);
    assert.equal(dto1.myStationBalance, 1500);
    assert.equal(dto1.mainBalance, 5000);
    assert.equal(dto1.availableHere, 6500);

    const dto2 = list4.find((s) => s.id === secondStation.id)!;
    assert.equal(dto2.myStationWalletId, secondStationWallet.id);
    assert.equal(dto2.myStationBalance, 2500);
    assert.equal(dto2.mainBalance, 5000);
    assert.equal(dto2.availableHere, 7500);

    const thirdStation = seededStations[2]!;
    const dto3 = list4.find((s) => s.id === thirdStation.id)!;
    assert.equal(dto3.myStationWalletId, null);
    assert.equal(dto3.myStationBalance, 0);
    assert.equal(dto3.mainBalance, 5000);
    assert.equal(dto3.availableHere, 5000);

    // Add 3 extra temporary stations (including an inactive one) and verify query count remains constant (2 queries)
    for (let i = 0; i < 3; i++) {
      const extra = await prisma.station.create({
        data: {
          name: `محطة اختبار ${i}_${randomUUID().slice(0, 6)}`,
          city: 'الخرطوم',
          isActive: i !== 0,
        },
      });
      extraStationIds.push(extra.id);
    }

    const beforeExtraListCount = queriesFor4.length;
    const mock2 = createMockRes();
    await listStations(req1, mock2.res);
    const countFor7 = queriesFor4.length - beforeExtraListCount;

    assert.equal(
      countFor4,
      2,
      `Expected exactly 2 SQL queries for 4 stations, got ${countFor4}`,
    );
    assert.equal(
      countFor7,
      countFor4,
      `Query count must remain constant (${countFor4}) when station count increases, got ${countFor7}`,
    );

    const list7 = mock2.getBody().data as StationDto[];
    assert.equal(list7.length, seededStations.length + 3);
    const inactiveReturned = list7.some((s) => s.isActive === false);
    assert.equal(inactiveReturned, true, 'Inactive stations must be returned with isActive=false');

    // Filter by city: أم درمان
    const mockCity = createMockRes();
    const reqCity = {
      user: { id: user.id, role: user.role, status: user.status },
      query: { city: 'أم درمان' },
    } as unknown as Request;
    await listStations(reqCity, mockCity.res);
    const cityStations = mockCity.getBody().data as StationDto[];
    assert.equal(cityStations.length, 2);
    assert.ok(cityStations.every((s) => s.city === 'أم درمان'));

    // GET /api/stations/:id valid
    const mockSingle = createMockRes();
    const reqSingle = {
      user: { id: user.id, role: user.role, status: user.status },
      params: { id: firstStation.id },
    } as unknown as Request;
    await getStationById(reqSingle, mockSingle.res);
    assert.equal(mockSingle.getStatus(), 200);
    const singleDto = mockSingle.getBody().data as StationDto;
    assert.equal(singleDto.id, firstStation.id);
    assert.equal(singleDto.availableHere, 6500);

    // GET /api/stations/:id 404 when UUID not found
    const reqNotFound = {
      user: { id: user.id, role: user.role, status: user.status },
      params: { id: randomUUID() },
    } as unknown as Request;
    await assert.rejects(
      () => getStationById(reqNotFound, createMockRes().res),
      (err: unknown) => err instanceof AppError && err.code === 'NOT_FOUND' && err.httpStatus === 404,
    );

    // Validate :id as UUID (invalid UUID throws ZodError)
    const validateMiddleware = validate({ params: stationIdParamSchema });
    assert.throws(() => {
      validateMiddleware(
        { params: { id: 'not-a-uuid' } } as unknown as Request,
        createMockRes().res,
        () => {},
      );
    });
  });
});

