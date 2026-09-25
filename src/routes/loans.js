import { Router } from 'express';
import { pool } from '../db.js';
import { ah, badRequest, notFound, mapLoan, todayISO } from '../utils.js';

const router = Router();

function statusFor(given, repaid) {
  if (repaid >= given - 1e-9) return 'REPAID';
  if (repaid > 0) return 'PARTIAL';
  return 'OPEN';
}

/** GET /api/loans — newest first. */
router.get(
  '/',
  ah(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM loans ORDER BY created_at DESC, id DESC');
    res.json(rows.map(mapLoan));
  })
);

/** POST /api/loans — Body: { borrowerName, amountGiven, dateGiven?, notes? } */
router.post(
  '/',
  ah(async (req, res) => {
    const { borrowerName, amountGiven, dateGiven, notes } = req.body ?? {};
    if (!borrowerName || String(borrowerName).trim() === '')
      throw badRequest('borrowerName is required');
    const amount = Number(amountGiven);
    if (!Number.isFinite(amount) || amount <= 0)
      throw badRequest('amountGiven must be a positive number');

    const [result] = await pool.query(
      `INSERT INTO loans (borrower_name, amount_given, amount_repaid, date_given, notes, status)
       VALUES (?, ?, 0, ?, ?, 'OPEN')`,
      [String(borrowerName).trim(), amount, dateGiven || todayISO(), notes || null]
    );
    const [rows] = await pool.query('SELECT * FROM loans WHERE id = ?', [result.insertId]);
    res.status(201).json(mapLoan(rows[0]));
  })
);

/**
 * PATCH /api/loans/:id/repay — Body: { amount }
 * Adds to amount_repaid, writes a row to loan_repayments, flips status to REPAID when fully paid.
 */
router.patch(
  '/:id/repay',
  ah(async (req, res) => {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest('amount must be a positive number');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM loans WHERE id = ? FOR UPDATE', [req.params.id]);
      if (rows.length === 0) {
        await conn.rollback();
        throw notFound('Loan not found');
      }
      const loan = rows[0];
      const given = Number(loan.amount_given);
      const repaid = Number(loan.amount_repaid);
      if (repaid >= given - 1e-9) {
        await conn.rollback();
        throw badRequest('Loan is already fully repaid');
      }
      if (repaid + amount > given + 1e-9) {
        await conn.rollback();
        throw badRequest(`Overpayment: only ${(given - repaid).toFixed(2)} KES outstanding`);
      }
      const newRepaid = repaid + amount;
      await conn.query('INSERT INTO loan_repayments (loan_id, amount) VALUES (?, ?)', [loan.id, amount]);
      await conn.query('UPDATE loans SET amount_repaid = ?, status = ? WHERE id = ?', [
        newRepaid.toFixed(2),
        statusFor(given, newRepaid),
        loan.id,
      ]);
      await conn.commit();
      const [updated] = await pool.query('SELECT * FROM loans WHERE id = ?', [loan.id]);
      res.json(mapLoan(updated[0]));
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* already handled */
      }
      throw e;
    } finally {
      conn.release();
    }
  })
);

export default router;
