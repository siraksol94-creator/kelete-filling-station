# Kelete Filling Station Management System

Bespoke management system for Kelete Investment Limited: a filling-station
operation with full accounting, inventory, point-of-sale, and fuel-specific
modules (tanks, pumps, nozzles, attendant shifts, dip readings, fleet customers).

Forked from the Redsea POS codebase on 2026-10-06. Single currency (Zambian
Kwacha). ZRA VSDC integration code is included but kept disabled for now.

Built with React, Electron, Node.js/Express, and SQLite (better-sqlite3).

## Features

Inherited from Redsea:
- Dashboard, POS, item catalog, GRN, SIV, inventory
- Cash Receipts / Payment Vouchers / Cash Book
- Accounts Payable / AP Payments, Sales Returns, Stock Adjustments
- Suppliers / Customers / Users (role-based permissions)
- Multi-branch with HQ consolidator
- Cross-device sync (Electron and VPS)

Fuel-specific (to be built on top):
- Fuel grades (Petrol, Diesel, Paraffin) with litres as the unit
- Tanks: capacity, current volume, dip-stick open/close readings
- Pumps and Nozzles linked to tanks with per-shift meter readings
- Attendant shift reconciliation (litres sold vs cash collected, variance)
- Fuel GRN (supplier to tank, litres received, cost/litre)
- Fleet / credit customers (vehicle reg, driver, credit limit, statements)
- Kiosk dry stock reuses the standard POS flow

## Tech Stack

| Layer    | Technology                          |
|----------|-------------------------------------|
| Frontend | React 18, React Router v6, Recharts |
| Desktop  | Electron                            |
| Backend  | Node.js, Express 4                  |
| Database | SQLite (better-sqlite3)             |
| Auth     | JWT + bcrypt                        |

## Setup

### 1. Install

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2. Configure Environment

Edit `backend/.env`:

```env
PORT=5303
TENANT_PORT=5303
JWT_SECRET=your_jwt_secret_here
TENANTS_DIR=../tenants
```

### 3. Run

```bash
# From root: start backend + frontend
npm run dev

# Desktop (Electron)
npm run desktop
```

### 4. Default Login

- Email: admin@keletezm.com
- Password: admin123

## Architecture

- `backend/server.js`: Electron / desktop server (port 5303)
- `backend/server-tenant.js`: Web multi-tenant server (port 5303), reads `X-Tenant` header set by nginx
- `tenants/<slug>.db`: Per-tenant SQLite DB
- VPS deploy: PM2 process name `kelete-fuel`, served at `keletezm.com`

## License

Private. All rights reserved. (c) Kelete Investment Limited.
