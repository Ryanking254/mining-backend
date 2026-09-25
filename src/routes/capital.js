import { Router } from 'express';
import { pool } from '../db.js';
import { ah, badRequest, num } from '../utils.js';

const router = Router();

async function capitalSnapshot() {
  const [[cap]] = await pool.query('SELECT starting_capital FROM capital_settings WHERE id = 1');
  const [[sales]] = await pool.query(
    'SELECT COALESCE(SUM(total_selling_price),0) AS revenue, COALESCE(SUM(profit_loss),0) AS profit FROM sales'
  );
  const [[purch]] = await pool.query(
    'SELECT COALESCE(SUM(total_cost),0) AS cost FROM batches'
  );
  const [[exp]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM expenditures');
  const [[wd]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM withdrawals');
  const [[loans]] = await pool.query(
    `SELECT COALESCE(SUM(amount_given),0) AS given,
            COALESCE(SUM(amount_repaid),0) AS repaid,
            COALESCE(SUM(amount_given - amount_repaid),0) AS outstanding
     FROM loans WHERE status != 'REPAID'`
  );

  const startingCapital = num(cap?.starting_capital);
  const salesRevenue = num(sales?.revenue);
  const salesProfit = num(sales?.profit);
  const purchaseCost = num(purch?.cost);
  const expenditures = num(exp?.total);
  const withdrawals = num(wd?.total);
  const loansOutstanding = num(loans?.outstanding);
  const loansGiven = num(loans?.given);
  const loansRepaid = num(loans?.repaid);

  // Cash currently in the business:
  // start + sales in + loan repayments in - stock bought - expenses - withdrawals - loans still out
  const currentCapital =
    startingCapital + salesRevenue - purchaseCost - expenditures - withdrawals - loansOutstanding;

  return {
    startingCapital,
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
 * The dashboard reads: currentCapital (fallback: total), breakdown { sales, expenditures }.
 */
router.get(
  '/',
  ah(async (req, res) => {
    res.json(await capitalSnapshot());
  })
);

/**
 * PUT /api/capital/starting
 * Body accepts any of: { amount } | { startingCapital } | { starting_capital }
 */
router.put(
  '/starting',
  ah(async (req, res) => {
    const raw = req.body?.amount ?? req.body?.startingCapital ?? req.body?.starting_capital;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
      throw badRequest('Provide a non-negative starting capital as `amount`');
    await pool.query(
      'INSERT INTO capital_settings (id, starting_capital) VALUES (1, ?) ON DUPLICATE KEY UPDATE starting_capital = ?',
      [value, value]
    );
    res.json(await capitalSnapshot());
  })
);

export default router;
