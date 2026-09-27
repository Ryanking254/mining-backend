import { Router } from 'express';
import { pool } from '../db.js';
import { ah, badRequest, mapExpenditure, todayISO } from '../utils.js';

const router = Router();

/** GET /api/expenditures — newest first. Scoped to the signed-in account. */
router.get(
  '/',
  ah(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT * FROM expenditures WHERE user_id = ? ORDER BY expense_date DESC, id DESC',
      [req.user.id]
    );
    res.json(rows.map(mapExpenditure));
  })
);

/** POST /api/expenditures — Body: { amount, category, description?, expenseDate? } */
router.post(
  '/',
  ah(async (req, res) => {
    const { amount, category, description, expenseDate } = req.body ?? {};
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw badRequest('amount must be a positive number');
    if (!category || String(category).trim() === '') throw badRequest('category is required');

    const [result] = await pool.query(
      `INSERT INTO expenditures (user_id, amount, category, description, expense_date)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, value, String(category).trim(), description || null, expenseDate || todayISO()]
    );
    const [rows] = await pool.query('SELECT * FROM expenditures WHERE id = ? AND user_id = ?', [result.insertId, req.user.id]);
    res.status(201).json(mapExpenditure(rows[0]));
  })
);

export default router;
