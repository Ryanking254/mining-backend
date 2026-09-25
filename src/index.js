import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pool, migrate, pingDb } from './db.js';
import batches from './routes/batches.js';
import sales from './routes/sales.js';
import loans from './routes/loans.js';
import expenditures from './routes/expenditures.js';
import withdrawals from './routes/withdrawals.js';
import capital from './routes/capital.js';

const app = express();
const PORT = Number(process.env.PORT || 8080);

const allowed = String(
  process.env.CORS_ORIGINS ||
    'http://localhost:5173,http://localhost:4173,https://mining-ledger.vercel.app'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({ origin: allowed, credentials: false }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (req, res) => {
  try {
    await pingDb();
    res.json({ ok: true, db: 'up' });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', error: e.message });
  }
});

app.use('/api/batches', batches);
app.use('/api/sales', sales);
app.use('/api/loans', loans);
app.use('/api/expenditures', expenditures);
app.use('/api/withdrawals', withdrawals);
app.use('/api/capital', capital);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler — validation errors become 400 with a clear message.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

async function boot() {
  if (String(process.env.AUTO_MIGRATE ?? '1') === '1') {
    try {
      await migrate();
      console.log('[db] schema ready');
    } catch (e) {
      console.error('[db] migration failed:', e.message);
      console.error('Check DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME (or DATABASE_URL) and that the TiDB user has CREATE privileges.');
    }
  }
  app.listen(PORT, () => {
    console.log(`[api] listening on http://localhost:${PORT}/api`);
    console.log(`[api] CORS origins: ${allowed.join(', ')}`);
  });
}

process.on('SIGTERM', async () => {
  await pool.end().catch(() => {});
  process.exit(0);
});

boot();
