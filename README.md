# Mining Backend

Express + MySQL backend for the Mining Website ledger. Works with local MySQL/MariaDB and **TiDB Cloud** (MySQL-protocol compatible, TLS on port `4000`).

Frontend expects the API at `http://localhost:8080/api` (see `Mining-Website/.env` → `VITE_API_BASE_URL`).

Production frontend: `https://mining-ledger.vercel.app`.

## Quick start

```bash
cd Mining-backend
cp .env.example .env   # then fill in your TiDB credentials
npm install
npm run dev            # or: npm start
```

Health check: `GET http://localhost:8080/api/health` → `{ ok: true, db: "up" }`.

## Deploy on Render

Settings to use when creating a **Web Service** on [render.com](https://render.com):

| Setting | Value |
|---|---|
| Environment | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |

> This project has no build step (plain Node.js + Express), so the build command just installs dependencies. The start command runs `node src/index.js` via `npm start`.

1. Push this folder to GitHub.
2. On Render: **New → Web Service →** select the repo.
3. Set **Build Command** to `npm install` and **Start Command** to `npm start`.
4. Add these **Environment Variables** (Render Dashboard → Environment):
   ```env
   PORT=8080
   CORS_ORIGINS=https://mining-ledger.vercel.app
   DB_HOST=gateway01.<region>.prod.aws.tidbcloud.com
   DB_PORT=4000
   DB_USER=<prefix>.root
   DB_PASSWORD=<password>
   DB_NAME=mining_ledger
   DB_SSL=true
   AUTO_MIGRATE=1
   ```
   Or instead of the discrete `DB_*` vars, set a single `DATABASE_URL=mysql://<user>:<password>@<host>:4000/<db>?sslaccept=strict`.
5. Deploy. Verify with `GET https://your-api.onrender.com/api/health` → `{ ok: true, db: "up" }`.

## TiDB Cloud setup

1. Create a cluster at [tidbcloud.com](https://tidbcloud.com) (Serverless is fine).
2. Create a database, e.g. `mining_ledger`.
3. In `.env` set:
   ```env
   DB_HOST=gateway01.<region>.prod.aws.tidbcloud.com
   DB_PORT=4000
   DB_USER=<prefix>.root
   DB_PASSWORD=<password>
   DB_NAME=mining_ledger
   DB_SSL=true
   ```
   Or use a single `DATABASE_URL=mysql://<user>:<password>@<host>:4000/<db>?sslaccept=strict`.
4. Leave `AUTO_MIGRATE=1` — tables are created automatically on boot. (`schema.sql` is included if you prefer to run DDL manually.)

## Endpoints (all JSON, all match the React frontend)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/batches?status=OPEN` | — | newest first |
| GET | `/api/batches/:id` | — | |
| POST | `/api/batches` | `{ itemName, gramsBought, pricePerGram, purchaseDate? }` | auto number `B-101…` |
| GET | `/api/sales` | — | includes `batchNumber`, `totalSellingPrice`, `profitLoss` |
| GET | `/api/sales/summary?range=daily\|weekly\|monthly` | — | `[{ period, revenue, profit }]` for charts |
| GET | `/api/sales/export` | — | downloads `sales.xlsx` |
| POST | `/api/sales` | `{ batchId, gramsSold, sellingPricePerGram, saleDate? }` | validates stock, closes batch at 0g |
| GET | `/api/loans` | — | |
| POST | `/api/loans` | `{ borrowerName, amountGiven, dateGiven?, notes? }` | |
| PATCH | `/api/loans/:id/repay` | `{ amount }` | rejects overpayment, sets `REPAID` |
| GET | `/api/expenditures` | — | |
| POST | `/api/expenditures` | `{ amount, category, description?, expenseDate? }` | |
| GET | `/api/withdrawals` | — | |
| POST | `/api/withdrawals` | `{ amount, reason?, withdrawalDate? }` | |
| GET | `/api/capital` | — | `{ currentCapital, total, breakdown{…} }` |
| PUT | `/api/capital/starting` | `{ amount }` | also accepts `startingCapital` |

Error shape: `{ error: "message" }` with 400 for validation, 404 for missing rows.

## Capital math

```
current = starting + salesRevenue − stockPurchases − expenditures − withdrawals − loansOutstanding
```

`GET /api/capital` returns the parts plus `total` (alias the dashboard falls back to) and `breakdown`.
