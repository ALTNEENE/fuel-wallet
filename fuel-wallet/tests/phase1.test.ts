import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { app } from '../src/app.js';
import { getMe } from '../src/controllers/me.controller.js';
import { prisma } from '../src/db/prisma.js';
import { ERROR_CATALOG } from '../src/errors/catalog.js';
import { WalletType } from '../src/generated/prisma/client.js';
import { ensureUserByClerkId } from '../src/middleware/ensure-user.js';

const createdClerkIds: string[] = [];

describe('Phase 1: Auth, identity, error plumbing, and GET /api/me', () => {
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
    await prisma.$disconnect();
  });

  it('(1) GET /api/me with no token returns 401 JSON envelope (no redirect)', async () => {
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/me`, {
        redirect: 'manual',
      });

      assert.equal(response.status, 401);
      const contentType = response.headers.get('content-type') ?? '';
      assert.match(contentType, /application\/json/i);

      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      assert.equal(body.error.code, 'UNAUTHENTICATED');
      assert.equal(body.error.message, ERROR_CATALOG.UNAUTHENTICATED.message);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('(2a) first-time ensureUserByClerkId creates exactly one User and one USER_MAIN wallet', async () => {
    const clerkUserId = `user_test_single_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const ensured = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'أحمد محمد',
      phone: '+249912345678',
    }));

    assert.ok(ensured.id);
    assert.equal(ensured.role, 'DRIVER');
    assert.equal(ensured.status, 'ACTIVE');

    const users = await prisma.user.findMany({
      where: { clerkUserId },
    });
    assert.equal(users.length, 1);
    assert.equal(users[0]?.fullName, 'أحمد محمد');
    assert.equal(users[0]?.phone, '+249912345678');

    const wallets = await prisma.wallet.findMany({
      where: { userId: ensured.id, type: WalletType.USER_MAIN },
    });
    assert.equal(wallets.length, 1);
    assert.equal(wallets[0]?.balance, 0n);
  });

  it('(2b) 5 parallel first-time calls create† exactly one User and one USER_MAIN wallet', async () => {
    const clerkUserId = `user_test_parallel_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureUserByClerkId(clerkUserId, async () => ({
          fullName: 'سارة علي',
          phone: '+249911111111',
        })),
      ),
    );

    assert.equal(results.length, 5);
    const uniqueIds = new Set(results.map((r) => r.id));
    assert.equal(uniqueIds.size, 1, 'All 5 parallel calls must return the same user ID');

    const userId = results[0]!.id;
    const userCount = await prisma.user.count({
      where: { clerkUserId },
    });
    assert.equal(userCount, 1, 'Must create† exactly 1 User row');

    const walletCount = await prisma.wallet.count({
      where: { userId, type: WalletType.USER_MAIN },
    });
    assert.equal(walletCount, 1, 'Must create† exactly 1 USER_MAIN wallet');
  });

  it('(2c) getMe returns expected envelope and allows FROZEN users to read', async () => {
    const clerkUserId = `user_test_frozen_${randomUUID()}`;
    createdClerkIds.push(clerkUserId);

    const ensured = await ensureUserByClerkId(clerkUserId, async () => ({
      fullName: 'مستخدم مجمد',
      phone: null,
    }));

    await prisma.user.update({
      where: { id: ensured.id },
      data: { status: 'FROZEN' },
    });

    let statusCode = 0;
    let jsonPayload: unknown = null;

    const req = {
      user: {
        id: ensured.id,
        role: 'DRIVER',
        status: 'FROZEN',
      },
    } as unknown as Request;

    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        jsonPayload = payload;
        return this;
      },
    } as unknown as Response;

    await getMe(req, res);

    assert.equal(statusCode, 200);
    const body = jsonPayload as {
      data: {
        user: { id: string; fullName: string | null; role: string; status: string };
        wallets: {
          main: { id: string; balance: number };
          stations: Array<{
            walletId: string;
            stationId: string;
            stationName: string;
            balance: number;
          }>;
        };
        totalBalance: number;
      };
    };

    assert.equal(body.data.user.id, ensured.id);
    assert.equal(body.data.user.fullName, 'مستخدم مجمد');
    assert.equal(body.data.user.status, 'FROZEN');
    assert.equal(typeof body.data.wallets.main.id, 'string');
    assert.equal(body.data.wallets.main.balance, 0);
    assert.deepEqual(body.data.wallets.stations, []);
    assert.equal(body.data.totalBalance, 0);
  });
});

