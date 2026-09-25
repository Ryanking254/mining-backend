import { Router } from 'express';
import { pool } from '../db.js';
import { ah, badRequest, mapExpenditure, todayISO } from '../utils.js';

const router = Router();

/** GET /api/expenditures — newest first. */
router.get(
  '/',
  ah(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT * FROM expenditures ORDER BY expense_date DESC, id DESC'
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
      `INSERT INTO expenditures (amount, category, description, expense_date)
       VALUES (?, ?, ?, ?)`,
      [value, String(category).trim(), description || null, expenseDate || todayISO()]
    );
    const [rows] = await pool.query('SELECT * FROM expenditures WHERE id = ?', [result.insertId]);
    res.status(201).json(mapExpenditure(rows[0]));
  })
);

export default router;
