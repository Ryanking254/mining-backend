import { Router } from 'express';
import { pool } from '../db.js';
import { ah, badRequest, notFound, mapBatch, todayISO } from '../utils.js';

const router = Router();

/**
 * GET /api/batches?status=OPEN
 * Returns newest first. Frontend uses `status` filter for the sale form.
 */
router.get(
  '/',
  ah(async (req, res) => {
    const { status } = req.query;
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [String(status).toUpperCase()] : [];
    const [rows] = await pool.query(
      `SELECT * FROM batches ${where} ORDER BY created_at DESC, id DESC`,
      params
    );
    res.json(rows.map(mapBatch));
  })
);

/** GET /api/batches/:id */
router.get(
  '/:id',
  ah(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM batches WHERE id = ?', [req.params.id]);
    if (rows.length === 0) throw notFound('Batch not found');
    res.json(mapBatch(rows[0]));
  })
);

/**
 * POST /api/batches
 * Body: { itemName, gramsBought, pricePerGram, purchaseDate? }
 * Batch numbers are deterministic: B-<100+id> (B-101, B-102, ...).
 */
router.post(
  '/',
  ah(async (req, res) => {
    const { itemName, gramsBought, pricePerGram, purchaseDate } = req.body ?? {};

    if (!itemName || String(itemName).trim() === '') throw badRequest('itemName is required');
    const grams = Number(gramsBought);
    const ppg = Number(pricePerGram);
    if (!Number.isFinite(grams) || grams <= 0) throw badRequest('gramsBought must be a positive number');
    if (!Number.isFinite(ppg) || ppg < 0) throw badRequest('pricePerGram must be a non-negative number');

    const date = purchaseDate || todayISO();
    const totalCost = grams * ppg;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO batches (batch_number, item_name, grams_bought, grams_remaining, price_per_gram, total_cost, purchase_date, status)
         VALUES ('PENDING', ?, ?, ?, ?, ?, ?, 'OPEN')`,
        [String(itemName).trim(), grams, grams, ppg, totalCost, date]
      );
      const id = result.insertId;
      const batchNumber = `B-${100 + id}`;
      await conn.query('UPDATE batches SET batch_number = ? WHERE id = ?', [batchNumber, id]);
      await conn.commit();
      const [rows] = await pool.query('SELECT * FROM batches WHERE id = ?', [id]);
      res.status(201).json(mapBatch(rows[0]));
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  })
);

export default router;
