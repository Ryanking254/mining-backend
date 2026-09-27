import { Router } from 'express';
import ExcelJS from 'exceljs';
import { pool } from '../db.js';
import { ah, badRequest, mapSale, todayISO } from '../utils.js';

const router = Router();

/**
 * GET /api/sales — newest first.
 * Frontend renders: batchNumber, gramsSold, totalSellingPrice, profitLoss, saleDate.
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
    res.json(rows.map(mapSale));
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
       GROUP BY grp ORDER BY MIN(s.sale_date) ASC`,
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
    for (const r of rows) {
      const sold = Number(r.grams_sold);
      const purity = r.purity_pct != null ? Number(r.purity_pct) : 100;
      ws.addRow({
        id: r.id,
        batch: r.batch_number,
        item: r.item_name,
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
 * Body: { batchId, gramsSold, sellingPricePerGram, saleDate?,
 *         purityPercentage? | percentage? | purity? }
 *  - gramsSold = NEW weight after burning / impurity removal (from the batch).
 *  - purityPercentage = assay % after impurity removal, 0–100 (default 100).
 *  - sellingPricePerGram = market price per gram.
 * Final amount: total = gramsSold × (purity / 100) × market price.
 * Stock deducted from the batch = gramsSold; cost basis = gramsSold × batch cost.
 */
router.post(
  '/',
  ah(async (req, res) => {
    const { batchId, gramsSold, sellingPricePerGram, saleDate } = req.body ?? {};
    const rawPurity =
      req.body?.purityPercentage ??
      req.body?.percentage ??
      req.body?.purity ??
      req.body?.purityPct ??
      req.body?.purity_pct;
    const sold = Number(gramsSold);
    const purity = rawPurity === undefined || rawPurity === '' || rawPurity === null ? 100 : Number(rawPurity);
    const ppg = Number(sellingPricePerGram);
    if (!batchId) throw badRequest('batchId is required');
    if (!Number.isFinite(sold) || sold <= 0) throw badRequest('weight must be a positive number');
    if (!Number.isFinite(purity) || purity <= 0 || purity > 100)
      throw badRequest('percentage must be between 0 and 100');
    if (!Number.isFinite(ppg) || ppg < 0)
      throw badRequest('market price per gram must be a non-negative number');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [batches] = await conn.query(
        'SELECT * FROM batches WHERE id = ? AND user_id = ? FOR UPDATE',
        [batchId, req.user.id]
      );
      if (batches.length === 0) {
        await conn.rollback();
        throw badRequest('Batch not found');
      }
      const batch = batches[0];
      const remaining = Number(batch.grams_remaining);
      if (batch.status === 'CLOSED' || remaining <= 0) {
        await conn.rollback();
        throw badRequest('Batch is closed (no stock remaining)');
      }
      if (sold > remaining + 1e-9) {
        await conn.rollback();
        throw badRequest(`Only ${remaining}g remaining in ${batch.batch_number}`);
      }

      const payable = (sold * purity) / 100;
      const total = payable * ppg;
      const costBasis = sold * Number(batch.price_per_gram);
      const profitLoss = total - costBasis;
      const date = saleDate || todayISO();

      const [result] = await conn.query(
        `INSERT INTO sales (user_id, batch_id, grams_taken, grams_sold, purity_pct, selling_price_per_gram, total_selling_price, cost_basis, profit_loss, sale_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, batch.id, sold, sold, purity, ppg, total, costBasis, profitLoss, date]
      );
      const newRemaining = remaining - sold;
      await conn.query('UPDATE batches SET grams_remaining = ?, status = ? WHERE id = ?', [
        newRemaining.toFixed(2),
        newRemaining <= 0.0001 ? 'CLOSED' : 'OPEN',
        batch.id,
      ]);
      await conn.commit();

      const [rows] = await pool.query(
        `SELECT s.*, b.batch_number FROM sales s JOIN batches b ON b.id = s.batch_id WHERE s.id = ? AND s.user_id = ?`,
        [result.insertId, req.user.id]
      );
      res.status(201).json(mapSale(rows[0]));
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
