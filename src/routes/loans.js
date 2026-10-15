import { Router } from 'express';
import { pool } from '../db.js';
import { ah, badRequest, notFound, mapLoan, todayISO } from '../utils.js';

const router = Router();

function statusFor(given, repaid) {
  if (repaid >= given - 1e-9) return 'REPAID';
  if (repaid > 0) return 'PARTIAL';
  return 'OPEN';
}

/** GET /api/loans — newest first. Scoped to the signed-in account. */
router.get(
  '/',
  ah(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC, id DESC',
      [req.user.id]
    );
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
      `INSERT INTO loans (user_id, borrower_name, amount_given, amount_repaid, date_given, notes, status)
       VALUES (?, ?, ?, 0, ?, ?, 'OPEN')`,
      [req.user.id, String(borrowerName).trim(), amount, dateGiven || todayISO(), notes || null]
    );
    const [rows] = await pool.query('SELECT * FROM loans WHERE id = ? AND user_id = ?', [result.insertId, req.user.id]);
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
      const [rows] = await conn.query('SELECT * FROM loans WHERE id = ? AND user_id = ? FOR UPDATE', [req.params.id, req.user.id]);
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
      const [updated] = await pool.query('SELECT * FROM loans WHERE id = ? AND user_id = ?', [loan.id, req.user.id]);
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

/**
 * PATCH /api/loans/:id/topup — Body: { amount }
 * Lends more on top of an existing loan (borrower takes another amount while
 * a balance is still pending). Increases amount_given, keeps amount_repaid,
 * writes a row to loan_topups, and recomputes status (a REPAID loan reopens).
 */
router.patch(
  '/:id/topup',
  ah(async (req, res) => {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest('amount must be a positive number');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM loans WHERE id = ? AND user_id = ? FOR UPDATE', [req.params.id, req.user.id]);
      if (rows.length === 0) {
        await conn.rollback();
        throw notFound('Loan not found');
      }
      const loan = rows[0];
      const given = Number(loan.amount_given);
      const repaid = Number(loan.amount_repaid);
      const newGiven = given + amount;
      await conn.query('INSERT INTO loan_topups (loan_id, amount) VALUES (?, ?)', [loan.id, amount]);
      await conn.query('UPDATE loans SET amount_given = ?, status = ? WHERE id = ?', [
        newGiven.toFixed(2),
        statusFor(newGiven, repaid),
        loan.id,
      ]);
      await conn.commit();
      const [updated] = await pool.query('SELECT * FROM loans WHERE id = ? AND user_id = ?', [loan.id, req.user.id]);
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

/** GET /api/loans/:id/topups — top-up history for one loan (newest first). */
router.get(
  '/:id/topups',
  ah(async (req, res) => {
    const [loanRows] = await pool.query('SELECT id FROM loans WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (loanRows.length === 0) throw notFound('Loan not found');
    const [rows] = await pool.query(
      'SELECT id, loan_id AS loanId, amount, created_at AS createdAt FROM loan_topups WHERE loan_id = ? ORDER BY id DESC',
      [req.params.id]
    );
    res.json(rows.map((r) => ({ ...r, amount: Number(r.amount) })));
  })
);

/**
 * GET /api/loans/:id/history — full event history for one loan, oldest first:
 * every repayment (amount + day) and every top-up (amount + day).
 * The initial "borrowed" event is the loan row itself (dateGiven).
 */
router.get(
  '/:id/history',
  ah(async (req, res) => {
    const [loanRows] = await pool.query('SELECT id FROM loans WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (loanRows.length === 0) throw notFound('Loan not found');
    const [repayments] = await pool.query(
      'SELECT id, loan_id AS loanId, amount, repaid_at AS repaidAt FROM loan_repayments WHERE loan_id = ? ORDER BY id ASC',
      [req.params.id]
    );
    const [topups] = await pool.query(
      'SELECT id, loan_id AS loanId, amount, created_at AS createdAt FROM loan_topups WHERE loan_id = ? ORDER BY id ASC',
      [req.params.id]
    );
    res.json({
      repayments: repayments.map((r) => ({ ...r, amount: Number(r.amount) })),
      topups: topups.map((r) => ({ ...r, amount: Number(r.amount) })),
    });
  })
);

export default router;
