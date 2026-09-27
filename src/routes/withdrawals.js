import { Router } from 'express';
import { pool } from '../db.js';
import { ah, badRequest, mapWithdrawal, todayISO } from '../utils.js';

const router = Router();

/** GET /api/withdrawals — newest first. Scoped to the signed-in account. */
router.get(
  '/',
  ah(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY withdrawal_date DESC, id DESC',
      [req.user.id]
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
      `INSERT INTO withdrawals (user_id, amount, reason, withdrawal_date) VALUES (?, ?, ?, ?)`,
      [req.user.id, value, reason || null, withdrawalDate || todayISO()]
    );
    const [rows] = await pool.query('SELECT * FROM withdrawals WHERE id = ? AND user_id = ?', [result.insertId, req.user.id]);
    res.status(201).json(mapWithdrawal(rows[0]));
  })
);

export default router;
