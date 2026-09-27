import { Router } from 'express';
import ExcelJS from 'exceljs';
import { pool } from '../db.js';
import { ah, badRequest, mapSale, todayISO } from '../utils.js';

const router = Router();

/**
 * Attach per-batch detail to raw sale rows via sale_batches.
 * Adds batch_ids / batch_numbers / batch_items arrays; rows predating the
 * backfill (no join rows yet) are left untouched for mapSale's fallback.
 */
async function attachSaleBatches(connOrPool, rows) {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const [items] = await connOrPool.query(
    `SELECT sb.sale_id, sb.batch_id, b.batch_number, b.item_name
     FROM sale_batches sb JOIN batches b ON b.id = sb.batch_id
     WHERE sb.sale_id IN (?) ORDER BY sb.id ASC`,
    [ids]
  );
  const bySale = new Map();
  for (const it of items) {
    if (!bySale.has(it.sale_id)) bySale.set(it.sale_id, []);
    bySale.get(it.sale_id).push(it);
  }
  return rows.map((r) => {
    const list = bySale.get(r.id);
    if (!list || list.length === 0) return r;
    return {
      ...r,
      batch_ids: list.map((x) => x.batch_id),
      batch_numbers: list.map((x) => x.batch_number),
      batch_items: list.map((x) => x.item_name),
    };
  });
}

/**
 * GET /api/sales — newest first.
 * Frontend renders: batchNumber, gramsSold, totalSellingPrice, profitLoss, saleDate.
 * Multi-batch sales also carry batchIds/batchNumbers/batchCount.
 * Scoped to the signed-in account.
 */
router.get(
  '/',
  ah(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT s.*, b.batch_number
       FROM sales s JOIN batches b ON b.id = s.batch_id
       WHERE s.user_id = ?
       ORDER BY s.sale_date DESC, s.id DESC`,
      [req.user.id]
    );
    res.json((await attachSaleBatches(pool, rows)).map(mapSale));
  })
);

/**
 * GET /api/sales/summary?range=daily|weekly|monthly
 * ...or with a custom calendar window:
 * GET /api/sales/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&bucket=daily|weekly|monthly
 * Returns [{ period, revenue, profit }].
 *  - daily   -> per day (preset: last 30 days)
 *  - weekly  -> per ISO week (preset: last 12 weeks)
 *  - monthly -> per month (preset: last 6 months)
 */
router.get(
  '/summary',
  ah(async (req, res) => {
    const bucketParam = String(req.query.bucket || req.query.range || 'monthly').toLowerCase();
    const bucket = ['daily', 'weekly', 'monthly'].includes(bucketParam) ? bucketParam : 'monthly';
    const { from, to } = req.query;

    let groupExpr;
    let periodExpr;

    if (bucket === 'daily') {
      groupExpr = 'DATE(s.sale_date)';
      periodExpr = "DATE_FORMAT(s.sale_date, '%d %b')";
    } else if (bucket === 'weekly') {
      groupExpr = 'YEARWEEK(s.sale_date, 3)';
      periodExpr = "CONCAT('W', WEEK(s.sale_date, 3))";
    } else {
      groupExpr = "DATE_FORMAT(s.sale_date, '%Y-%m')";
      periodExpr = "DATE_FORMAT(s.sale_date, '%b')";
    }

    const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

    let where;
    let params = [];
    if (from !== undefined || to !== undefined) {
      // Custom calendar window — both ends required.
      if (!isDate(from)) throw badRequest('from must be YYYY-MM-DD');
      if (!isDate(to)) throw badRequest('to must be YYYY-MM-DD');
      if (from > to) throw badRequest('from must be on or before to');
      where = 'WHERE s.user_id = ? AND s.sale_date >= ? AND s.sale_date <= ?';
      params = [req.user.id, from, to];
    } else if (bucket === 'daily') {
      where = 'WHERE s.user_id = ? AND s.sale_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
      params = [req.user.id];
    } else if (bucket === 'weekly') {
      where = 'WHERE s.user_id = ? AND s.sale_date >= DATE_SUB(CURDATE(), INTERVAL 12 WEEK)';
      params = [req.user.id];
    } else {
      where = 'WHERE s.user_id = ? AND s.sale_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)';
      params = [req.user.id];
    }

    const [rows] = await pool.query(
      `SELECT ${groupExpr} AS grp, ${periodExpr} AS period,
              SUM(s.total_selling_price) AS revenue,
              SUM(s.profit_loss) AS profit
       FROM sales s
       ${where}
       GROUP BY grp, period ORDER BY MIN(s.sale_date) ASC`,
      params
    );
    res.json(
      rows.map((r) => ({
        period: r.period,
        revenue: Number(r.revenue),
        profit: Number(r.profit),
      }))
    );
  })
);

/**
 * GET /api/sales/export — download every sale as .xlsx (used by the sidebar button).
 */
router.get(
  '/export',
  ah(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT s.*, b.batch_number, b.item_name
       FROM sales s JOIN batches b ON b.id = s.batch_id
       WHERE s.user_id = ?
       ORDER BY s.sale_date DESC, s.id DESC`,
      [req.user.id]
    );
    const enriched = await attachSaleBatches(pool, rows);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mining Ledger';
    const ws = wb.addWorksheet('Sales');
    ws.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Batch', key: 'batch', width: 14 },
      { header: 'Item', key: 'item', width: 22 },
      { header: 'Weight (g)', key: 'grams', width: 13 },
      { header: 'Purity %', key: 'purity', width: 10 },
      { header: 'Payable (g)', key: 'payable', width: 13 },
      { header: 'Price / g (KES)', key: 'ppg', width: 16 },
      { header: 'Total (KES)', key: 'total', width: 15 },
      { header: 'Profit / Loss (KES)', key: 'pl', width: 19 },
      { header: 'Sale date', key: 'date', width: 13 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of enriched) {
      const sold = Number(r.grams_sold);
      const purity = r.purity_pct != null ? Number(r.purity_pct) : 100;
      const numbers = Array.isArray(r.batch_numbers) && r.batch_numbers.length > 0
        ? r.batch_numbers
        : [r.batch_number];
      const items = Array.isArray(r.batch_items) && r.batch_items.length > 0
        ? [...new Set(r.batch_items)]
        : [r.item_name];
      ws.addRow({
        id: r.id,
        batch: numbers.join(', '),
        item: items.join(', '),
        grams: sold,
        purity,
        payable: (sold * purity) / 100,
        ppg: Number(r.selling_price_per_gram),
        total: Number(r.total_selling_price),
        pl: Number(r.profit_loss),
        date: r.sale_date,
      });
    }
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="sales.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  })
);

/**
 * POST /api/sales
 * Single batch (partial allowed):
 *   { batchId, gramsSold, sellingPricePerGram, saleDate?,
 *     purityPercentage? | percentage? | purity? }
 * Combined multi-batch sale (sells the FULL remaining weight of each batch,
 * totals are summed and the sale math continues from there):
 *   { batchIds: [id, id, ...], sellingPricePerGram, saleDate?,
 *     purityPercentage? | percentage? | purity? }
 *  - gramsSold = NEW weight after burning / impurity removal.
 *  - purityPercentage = assay % after impurity removal, 0–100 (default 100).
 *  - sellingPricePerGram = market price per gram.
 * Final amount: total = weight × (purity / 100) × market price.
 * Single: stock deducted = gramsSold; cost = gramsSold × batch cost.
 * Multi: stock deducted = full remaining per batch; cost = Σ (remaining × cost).
 */
router.post(
  '/',
  ah(async (req, res) => {
    const { batchId, gramsSold, sellingPricePerGram, saleDate } = req.body ?? {};
    const rawIds = req.body?.batchIds ?? req.body?.batch_ids ?? req.body?.batchIDList;
    const rawPurity =
      req.body?.purityPercentage ??
      req.body?.percentage ??
      req.body?.purity ??
      req.body?.purityPct ??
      req.body?.purity_pct;
    const purity = rawPurity === undefined || rawPurity === '' || rawPurity === null ? 100 : Number(rawPurity);
    const ppg = Number(sellingPricePerGram);
    if (!Number.isFinite(purity) || purity <= 0 || purity > 100)
      throw badRequest('percentage must be between 0 and 100');
    if (!Number.isFinite(ppg) || ppg < 0)
      throw badRequest('market price per gram must be a non-negative number');

    // Resolve the batch selection: multi (batchIds[]) or legacy single (batchId).
    let ids = [];
    if (Array.isArray(rawIds) && rawIds.length > 0) {
      ids = [...new Set(rawIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
    } else if (batchId !== undefined && batchId !== '' && batchId !== null) {
      const single = Number(batchId);
      if (Number.isInteger(single) && single > 0) ids = [single];
    }
    if (ids.length === 0) throw badRequest('Select at least one batch');
    if (ids.length > 50) throw badRequest('Too many batches in one sale (max 50)');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [found] = await conn.query(
        'SELECT * FROM batches WHERE id IN (?) AND user_id = ? FOR UPDATE',
        [ids, req.user.id]
      );
      if (found.length !== ids.length) {
        await conn.rollback();
        throw badRequest('One or more batches were not found');
      }
      // Keep the client's selection order so batch_id = first selected batch.
      const byId = new Map(found.map((b) => [Number(b.id), b]));
      const batches = ids.map((id) => byId.get(id));
      for (const b of batches) {
        if (b.status === 'CLOSED' || Number(b.grams_remaining) <= 0) {
          await conn.rollback();
          throw badRequest(`Batch ${b.batch_number} is closed (no stock remaining)`);
        }
      }

      let takes; // grams taken from each batch, in selection order
      if (ids.length > 1) {
        // Combined sale: full remaining weight of every selected batch.
        if (gramsSold !== undefined && gramsSold !== '' && gramsSold !== null) {
          await conn.rollback();
          throw badRequest(
            'Multi-batch sales use the full remaining weight of each batch — clear the weight field or select a single batch for a partial sale'
          );
        }
        takes = batches.map((b) => Number(b.grams_remaining));
      } else {
        const sold = Number(gramsSold);
        if (!Number.isFinite(sold) || sold <= 0) {
          await conn.rollback();
          throw badRequest('weight must be a positive number');
        }
        const remaining = Number(batches[0].grams_remaining);
        if (sold > remaining + 1e-9) {
          await conn.rollback();
          throw badRequest(`Only ${remaining}g remaining in ${batches[0].batch_number}`);
        }
        takes = [sold];
      }

      const soldTotal = takes.reduce((a, t) => a + t, 0);
      const costBasis = takes.reduce((a, t, i) => a + t * Number(batches[i].price_per_gram), 0);
      const payable = (soldTotal * purity) / 100;
      const total = payable * ppg;
      const profitLoss = total - costBasis;
      const date = saleDate || todayISO();

      const [result] = await conn.query(
        `INSERT INTO sales (user_id, batch_id, grams_taken, grams_sold, purity_pct, selling_price_per_gram, total_selling_price, cost_basis, profit_loss, sale_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, batches[0].id, soldTotal, soldTotal, purity, ppg, total, costBasis, profitLoss, date]
      );
      await conn.query('INSERT INTO sale_batches (sale_id, batch_id, grams_sold, cost_basis) VALUES ?', [
        takes.map((t, i) => [result.insertId, batches[i].id, t, t * Number(batches[i].price_per_gram)]),
      ]);
      for (let i = 0; i < batches.length; i++) {
        const newRemaining = Number(batches[i].grams_remaining) - takes[i];
        await conn.query('UPDATE batches SET grams_remaining = ?, status = ? WHERE id = ?', [
          newRemaining.toFixed(2),
          newRemaining <= 0.0001 ? 'CLOSED' : 'OPEN',
          batches[i].id,
        ]);
      }
      await conn.commit();

      const [rows] = await pool.query(
        `SELECT s.*, b.batch_number FROM sales s JOIN batches b ON b.id = s.batch_id WHERE s.id = ? AND s.user_id = ?`,
        [result.insertId, req.user.id]
      );
      res.status(201).json(mapSale((await attachSaleBatches(pool, rows))[0]));
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      conn.release();
    }
  })
);

export default router;
