# Fuel Wallet Backend

Prepaid fuel wallet backend built with **Node.js**, **Express 5**, **TypeScript (pure ESM)**, **Prisma 7** (`@prisma/adapter-pg`), **PostgreSQL**, and **Clerk** (`@clerk/express`).

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env

# 3. Apply database migrations & seed initial data
npm run db:deploy
npm run db:seed
npm run db:verify

# 4. Reset demo data (optional, non-production only)
npm run demo:reset

# 5. Run development server, production build, or test suite
npm run dev
npm run build && npm start
npm test
```

Interactive HTTP requests for all endpoints are available in [`api.http`](./api.http) (VS Code REST Client) using a `@token` variable.

---

## Promoting Users (`ADMIN` and `OPERATOR`)

New users authenticate via Clerk and are automatically provisioned on their first API request with `role = 'DRIVER'` and `status = 'ACTIVE'`.

### 1. Promote a user to `ADMIN`
Run the following SQL against PostgreSQL using the user's Clerk User ID (`user_...`) or internal UUID:

```sql
UPDATE "users"
SET "role" = 'ADMIN'
WHERE "clerk_user_id" = 'user_2xYourClerkUserIdHere';
```

### 2. Promote a user to Station `OPERATOR`
Assign `role = 'OPERATOR'` and link the user to their station via `operator_station_id`:

```sql
UPDATE "users"
SET
  "role" = 'OPERATOR',
  "operator_station_id" = (
    SELECT "id"
    FROM "stations"
    WHERE "name" = 'محطة النيل' AND "city" = 'أم درمان'
  )
WHERE "clerk_user_id" = 'user_2xOperatorClerkUserIdHere';
```

### 3. Freeze or Unfreeze a User
Via the Admin API:
- `PATCH /api/admin/users/:id` with `{ "status": "FROZEN" }` or `{ "status": "ACTIVE" }`

Or directly in SQL:
```sql
UPDATE "users"
SET "status" = 'FROZEN'
WHERE "id" = '<user-uuid>';
```

---

## Demo Flow (End-to-End Walkthrough)

Before starting a live demonstration, reset the database state (`TRUNCATE ledger_entries, transactions RESTART IDENTITY`, remove `USER_STATION` wallets, zero all wallet balances, and set `bank_gateway_status = "UP"`):

```bash
npm run demo:reset
```

Then walk through the competition scenario:

1. **Top-Up (`POST /api/topups`)**
   - Top up `30,000` SDG into the driver's `USER_MAIN` wallet (`Idempotency-Key: demo-topup-1`).
   - Result: `201 Created`, `status: "COMPLETED"`, `USER_MAIN` balance = `30,000`, `BANK_SIM` balance = `-30,000`.
2. **Pick Station (`GET /api/stations`)**
   - List active fuel stations (e.g. **Station A — محطة الأمل** and **Station B — محطة السلام**).
   - Each station shows `myStationBalance: 0`, `mainBalance: 30000`, `availableHere: 30000`.
3. **Transfer Main -> Station A (`POST /api/transfers`)**
   - Move `20,000` SDG from `USER_MAIN` to `{ "type": "STATION", "stationId": "<stationAId>" }`.
   - Result: `USER_MAIN` balance = `10,000`, `Station A` user wallet balance = `20,000`.
4. **Pay at Station A (`POST /api/payments`)**
   - Pay `12,000` SDG at **Station A** using the driver's Station A wallet.
   - Result: `201 Created` with a 6-digit `verificationCode` (verifiable by Station A's operator via `GET /api/operator/payments/lookup?code=...`), leaving `8,000` SDG in the driver's Station A wallet and crediting `+12,000` SDG to Station A's `STATION_REVENUE` wallet.
5. **Transfer Station A -> Station B (`POST /api/transfers`)**
   - Reallocate the remaining `8,000` SDG from the driver's Station A wallet to `{ "type": "STATION", "stationId": "<stationBId>" }`.
   - Result: driver's Station A wallet = `0`, driver's Station B wallet = `8,000`.
6. **Pay at Station B (`POST /api/payments`)**
   - Pay `5,000` SDG at **Station B** using the driver's Station B wallet.
   - Result: `201 Created` with a 6-digit `verificationCode`, leaving `3,000` SDG in the driver's Station B wallet and crediting `+5,000` SDG to Station B's `STATION_REVENUE` wallet.
7. **History & Statements (`GET /api/transactions` & `GET /api/wallets/:id/ledger`)**
   - Inspect cursor-paginated transaction history (`reference`, `type`, `status`, `from`, `to`, `verificationCode`) and double-entry wallet ledger statements (`delta`, `balanceAfter`, `reference`).
8. **Bank `DOWN` Resilience (`POST /api/admin/bank-status`)**
   - Switch bank gateway to `DOWN`: `POST /api/admin/bank-status { "status": "DOWN" }`.
   - **Top-Up fails gracefully**: `POST /api/topups { "amount": 5000 }` returns `503 BANK_UNAVAILABLE`, records a `FAILED` transaction row (`failureCode: "BANK_UNAVAILABLE"`), writes **zero** ledger entries, and leaves balances unchanged.
   - **Wallet Payments & Transfers still work**: Paying `3,000` SDG at **Station B** (`POST /api/payments`) succeeds with `201 Created` (leaving `0` at Station B and `+8,000` in Station B revenue) because wallet-to-station settlements operate purely on the internal double-entry ledger without external bank dependency.
9. **Reconcile (`GET /api/admin/reconcile`)**
   - Run the admin reconciliation check: returns `{ "ok": true, "issues": [] }`, confirming:
     - Every wallet's `balance` equals `SUM(delta)` of its `ledger_entries`.
     - Every `COMPLETED` transaction has exactly 2 ledger entries summing to `0`.
     - Every `FAILED` / `PENDING` transaction has `0` ledger entries.
     - The sum of all wallet balances across the entire system equals `0`.
