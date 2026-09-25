import { Router } from 'express';
import { pool } from '../db.js';
import { ah, badRequest, mapWithdrawal, todayISO } from '../utils.js';

const router = Router();

/** GET /api/withdrawals — newest first. */
router.get(
  '/',
  ah(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT * FROM withdrawals ORDER BY withdrawal_date DESC, id DESC'
    );
    res.json(rows.map(mapWithdrawal));
  })
);

/** POST /api/withdrawals — Body: { amount, reason?, withdrawalDate? } */
router.post(
  '/',
  ah(async (req, res) => {
    const { amount, reason, withdrawalDate } = req.body ?? {};
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw badRequest('amount must be a positive number');

    const [result] = await pool.query(
      `INSERT INTO withdrawals (amount, reason, withdrawal_date) VALUES (?, ?, ?)`,
      [value, reason || null, withdrawalDate || todayISO()]
    );
    const [rows] = await pool.query('SELECT * FROM withdrawals WHERE id = ?', [result.insertId]);
    res.status(201).json(mapWithdrawal(rows[0]));
  })
);

export default router;
