import { Router } from 'express';
import { pool } from '../db.js';
import { ah, badRequest, num } from '../utils.js';

const router = Router();

async function ensureCapitalRow(userId) {
  await pool.query(
    'INSERT IGNORE INTO capital_settings (user_id, starting_capital) VALUES (?, 0)',
    [userId]
  );
}

async function capitalSnapshot(userId) {
  await ensureCapitalRow(userId);
  const [[cap]] = await pool.query('SELECT starting_capital FROM capital_settings WHERE user_id = ?', [userId]);
  const [[sales]] = await pool.query(
    'SELECT COALESCE(SUM(total_selling_price),0) AS revenue, COALESCE(SUM(profit_loss),0) AS profit FROM sales WHERE user_id = ?',
    [userId]
  );
  const [[purch]] = await pool.query(
    'SELECT COALESCE(SUM(total_cost),0) AS cost FROM batches WHERE user_id = ?',
    [userId]
  );
  const [[exp]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM expenditures WHERE user_id = ?', [userId]);
  const [[wd]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM withdrawals WHERE user_id = ?', [userId]);
  const [[loans]] = await pool.query(
    `SELECT COALESCE(SUM(amount_given),0) AS given,
            COALESCE(SUM(amount_repaid),0) AS repaid,
            COALESCE(SUM(amount_given - amount_repaid),0) AS outstanding
     FROM loans WHERE user_id = ? AND status != 'REPAID'`,
    [userId]
  );
  let added = 0;
  try {
    const [[row]] = await pool.query(
      'SELECT COALESCE(SUM(amount),0) AS total FROM capital_additions WHERE user_id = ?',
      [userId]
    );
    added = num(row?.total);
  } catch {
    added = 0;
  }

  const startingCapital = num(cap?.starting_capital);
  const manualAdditions = added;
  const salesRevenue = num(sales?.revenue);
  const salesProfit = num(sales?.profit);
  const purchaseCost = num(purch?.cost);
  const expenditures = num(exp?.total);
  const withdrawals = num(wd?.total);
  const loansOutstanding = num(loans?.outstanding);
  const loansGiven = num(loans?.given);
  const loansRepaid = num(loans?.repaid);

  // Cash currently in the business:
  // start + manual top-ups + sales in + loan repayments in
  //   - stock bought - expenses - withdrawals - loans still out
  const currentCapital =
    startingCapital + manualAdditions + salesRevenue - purchaseCost - expenditures - withdrawals - loansOutstanding;

  return {
    startingCapital,
    manualAdditions,
    addedCapital: manualAdditions,
    salesRevenue,
    salesProfit,
    purchaseCost,
    expenditures,
    withdrawals,
    loansOutstanding,
    loansGiven,
    loansRepaid,
    currentCapital,
    // Alias the dashboard reads first (`capital?.currentCapital ?? capital?.total`).
    total: currentCapital,
    breakdown: {
      starting: startingCapital,
      added: manualAdditions,
      sales: salesRevenue,
      profit: salesProfit,
      purchases: purchaseCost,
      expenditures,
      withdrawals,
      loansOutstanding,
    },
  };
}

/**
 * GET /api/capital
 * Per-account snapshot. The dashboard reads: currentCapital (fallback: total),
 * breakdown { sales, expenditures }.
 */
router.get(
  '/',
  ah(async (req, res) => {
    res.json(await capitalSnapshot(req.user.id));
  })
);

/**
 * PUT /api/capital/starting
 * Body accepts any of: { amount } | { startingCapital } | { starting_capital }
 * Sets (replaces) this account's starting capital.
 */
router.put(
  '/starting',
  ah(async (req, res) => {
    const raw = req.body?.amount ?? req.body?.startingCapital ?? req.body?.starting_capital;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
      throw badRequest('Provide a non-negative starting capital as `amount`');
    await pool.query(
      'INSERT INTO capital_settings (user_id, starting_capital) VALUES (?, ?) ON DUPLICATE KEY UPDATE starting_capital = ?',
      [req.user.id, value, value]
    );
    res.json(await capitalSnapshot(req.user.id));
  })
);

/**
 * POST /api/capital/add
 * Body: { amount, note? } — manually top up the current capital (extra cash
 * injected into the business). Tracked in capital_additions history so the
 * running total stays auditable.
 */
router.post(
  '/add',
  ah(async (req, res) => {
    const value = Number(req.body?.amount);
    if (!Number.isFinite(value) || value <= 0)
      throw badRequest('Provide a positive amount to add as `amount`');
    const note = req.body?.note != null && String(req.body.note).trim() !== ''
      ? String(req.body.note).trim().slice(0, 255)
      : null;
    await ensureCapitalRow(req.user.id);
    await pool.query('INSERT INTO capital_additions (user_id, amount, note) VALUES (?, ?, ?)', [
      req.user.id,
      value,
      note,
    ]);
    res.status(201).json(await capitalSnapshot(req.user.id));
  })
);

/**
 * GET /api/capital/additions — manual top-up history for this account.
 */
router.get(
  '/additions',
  ah(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT id, amount, note, created_at AS createdAt FROM capital_additions WHERE user_id = ? ORDER BY id DESC',
      [req.user.id]
    );
    res.json(
      rows.map((r) => ({ id: r.id, amount: Number(r.amount), note: r.note, createdAt: r.createdAt }))
    );
  })
);

export default router;
