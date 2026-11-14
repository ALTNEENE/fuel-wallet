# Fuel Wallet — Frontend Application (`/client`)

Modern digital financial wallet frontend for the **Fuel Wallet** platform, built with **React 19**, **Vite 8**, **TypeScript**, **Tailwind CSS**, **Clerk React (`@clerk/clerk-react`)**, **Axios**, **TanStack React Query**, and **React Router**.

---

## Running the Application

1. **Start the Express Backend** (in `../fuel-wallet` on port `3000`):
   ```bash
   cd ../fuel-wallet
   npm run dev
   ```

2. **Configure Frontend Environment Variables** (`.env` in `/client`):
   ```bash
   cp .env.example .env
   ```
   Ensure `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_API_URL=http://localhost:3000/api` are set.

3. **Start the Vite Development Server** (in `/client` on port `5173`):
   ```bash
   npm run dev
   ```

4. **Typecheck, Lint, and Build for Production**:
   ```bash
   npm run lint
   npm run build
   ```

---

## Key Features

- **Trust Wallet-Inspired Design System**: Dark Mode (deep obsidian navy & electric cobalt/violet) and Light Mode (crisp alabaster & royal blue) persisted in `localStorage`.
- **Full Arabic (RTL) & English (LTR) Localization**: Instant language and direction switching across all screens.
- **Clerk Authentication & Automatic Backend Sync**: Seamless JWT injection via Axios request interceptor and automatic database profile/wallet provisioning via `GET /api/me`.
- **Customer Wallet & Station Management**: View `USER_MAIN` and allocated `USER_STATION` wallets, double-entry ledger statements (`GET /api/wallets/:id/ledger`), and simulated bank top-ups (`POST /api/topups`).
- **Fuel Station Payments & 6-Digit Verification Receipt**: Pay from a dedicated station wallet or `USER_MAIN` (`POST /api/payments`), receive a 6-digit verification code for the station attendant, and reconcile transaction status with the backend (`GET /api/transactions/:id`).
- **Atomic Transfers**: Move balance between `USER_MAIN` and `USER_STATION` or directly between stations (`Station A -> Station B`) via `POST /api/transfers` with cryptographic `Idempotency-Key` protection.
- **Role-Based Dashboards**:
  - **Station Operator Hub (`/operator`)**: Today's station revenue summary, 30-minute 6-digit payment code verification lookup, live congestion level control (`LOW` / `MEDIUM` / `HIGH`), and incoming station payment feed with masked payer names.
  - **System Admin Console (`/admin`)**: Simulated Bank Gateway switch (`UP` / `DOWN`), real-time Double-Entry Ledger Reconciliation (`GET /api/admin/reconcile`), station activation/deactivation, per-station inspection, and user account freeze/unfreeze (`ACTIVE` / `FROZEN`).
