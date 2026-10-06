import { Router } from 'express';
import { pool } from '../db.js';
import {
  ah,
  badRequest,
  notFound,
  num,
  mapBatch,
  mapSale,
  mapLoan,
  mapExpenditure,
  mapWithdrawal,
} from '../utils.js';

const router = Router();

const mapAdminUser = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  avatarUrl: r.avatar_url ?? null,
  isAdmin: !!r.is_admin,
  isSuspended: !!r.is_suspended,
  suspensionReason: r.suspension_reason ?? null,
  suspendedAt: r.suspended_at ?? null,
  twofaEnabled: !!r.twofa_enabled,
  twofaExempt: !!(r.twofa_exempt ?? 0),
  createdAt: r.created_at,
});

const mapDisableRequest = (r) => ({
  id: r.id,
  status: r.status,
  reason: r.reason ?? null,
  adminNote: r.admin_note ?? null,
  createdAt: r.created_at,
  decidedAt: r.decided_at ?? null,
  decidedBy: r.decided_by ?? null,
  user: {
    id: r.user_id,
    name: r.user_name ?? null,
    email: r.user_email ?? null,
    twofaEnabled: r.user_twofa_enabled != null ? !!r.user_twofa_enabled : undefined,
  },
});

/**
 * GET /api/admin/users — list every account (admin only).
 * Newest last? Oldest first so the owner sees signups in order; sorted by id.
 */
router.get(
  '/users',
  ah(async (req, res) => {
    let rows;
    try {
      [rows] = await pool.query(
        `SELECT id, name, email, avatar_url, is_admin, is_suspended,
                suspension_reason, suspended_at, twofa_enabled, twofa_exempt, created_at
         FROM users ORDER BY id ASC`
      );
    } catch (e) {
      // Older DBs without the admin columns — select the base columns and
      // synthesize defaults so the admin page doesn't 500 before migrate runs.
      if (e?.code === 'ER_BAD_FIELD_ERROR') {
        try {
          [rows] = await pool.query(
            `SELECT id, name, email, avatar_url, is_admin, is_suspended,
                    suspension_reason, suspended_at, twofa_enabled, created_at
             FROM users ORDER BY id ASC`
          );
          return res.json(rows.map((r) => ({ ...mapAdminUser(r), twofaExempt: false })));
        } catch {
          /* fall through to the oldest fallback below */
        }
        const [base] = await pool.query(
          `SELECT id, name, email, avatar_url, twofa_enabled, created_at FROM users ORDER BY id ASC`
        );
        return res.json(
          base.map((r) => ({
            id: r.id,
            name: r.name,
            email: r.email,
            avatarUrl: r.avatar_url ?? null,
            isAdmin: false,
            isSuspended: false,
            suspensionReason: null,
            suspendedAt: null,
            twofaEnabled: !!r.twofa_enabled,
            twofaExempt: false,
            createdAt: r.created_at,
          }))
        );
      }
      throw e;
    }
    res.json(rows.map(mapAdminUser));
  })
);

/**
 * PATCH /api/admin/users/:id/suspend — killswitch (admin only).
 * Body: { suspended: boolean, reason?: string }
 * - suspended=true pauses the account; `reason` is shown to the user as
 *   "Your services have been paused due to: <reason>".
 * - suspended=false re-activates (clears reason).
 * Admins (incl. yourself) can never be suspended.
 */
router.patch(
  '/users/:id/suspend',
  ah(async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) throw badRequest('Invalid user id');
    const suspended = req.body?.suspended;
    if (typeof suspended !== 'boolean') throw badRequest('`suspended` must be true or false');
    const reasonRaw = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (suspended && reasonRaw === '') throw badRequest('A reason is required to pause services.');
    if (suspended && reasonRaw.length > 1000) throw badRequest('Reason is too long (max 1000 chars).');

    if (targetId === Number(req.user.id)) throw badRequest('You cannot pause your own admin account.');

    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [targetId]);
    if (rows.length === 0) throw notFound('User not found');
    if (rows[0].is_admin) throw badRequest('Admin accounts cannot be paused.');

    await pool.query(
      'UPDATE users SET is_suspended = ?, suspension_reason = ?, suspended_at = ? WHERE id = ?',
      [
        suspended ? 1 : 0,
        suspended ? reasonRaw.slice(0, 1000) : null,
        suspended ? new Date() : null,
        targetId,
      ]
    );
    const [refreshed] = await pool.query(
      `SELECT id, name, email, avatar_url, is_admin, is_suspended,
              suspension_reason, suspended_at, twofa_enabled, twofa_exempt, created_at
       FROM users WHERE id = ?`,
      [targetId]
    );
    res.json(mapAdminUser(refreshed[0]));
  })
);

/* ------------------------------------------------------------------ */
/* Authenticator disable requests: user asks, admin approves/rejects.  */
/* 2FA stays ON until approval; approval turns it OFF + exempts the    */
/* account from the mandatory-authenticator grace enforcement.         */
/* ------------------------------------------------------------------ */

async function getDisableRequest(id) {
  try {
    const [rows] = await pool.query(
      `SELECT t.*, u.name AS user_name, u.email AS user_email,
              u.twofa_enabled AS user_twofa_enabled
       FROM twofa_disable_requests t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`,
      [id]
    );
    return rows[0] || null;
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') return null;
    throw e;
  }
}

/** Turn a user's 2FA off and mark them exempt from mandatory 2FA. */
async function disableUserTwofa(userId) {
  try {
    await pool.query(
      'UPDATE users SET twofa_enabled = 0, twofa_secret = NULL, twofa_backup_codes = NULL, twofa_exempt = 1 WHERE id = ?',
      [userId]
    );
  } catch (e) {
    if (e?.code === 'ER_BAD_FIELD_ERROR') {
      // Older DBs without twofa_exempt — still turn 2FA off.
      await pool.query(
        'UPDATE users SET twofa_enabled = 0, twofa_secret = NULL, twofa_backup_codes = NULL WHERE id = ?',
        [userId]
      );
    } else {
      throw e;
    }
  }
}

/**
 * GET /api/admin/2fa/disable-requests?status=PENDING (or ALL) — admin only.
 * Lists authenticator disable requests with the requesting account attached.
 */
router.get(
  '/2fa/disable-requests',
  ah(async (req, res) => {
    const filter = String(req.query?.status ?? 'PENDING').trim().toUpperCase();
    let rows;
    try {
      if (filter === 'ALL') {
        [rows] = await pool.query(
          `SELECT t.*, u.name AS user_name, u.email AS user_email,
                  u.twofa_enabled AS user_twofa_enabled
           FROM twofa_disable_requests t
           JOIN users u ON u.id = t.user_id
           ORDER BY
             CASE t.status WHEN 'PENDING' THEN 0 ELSE 1 END ASC,
             t.id DESC
           LIMIT 100`
        );
      } else {
        [rows] = await pool.query(
          `SELECT t.*, u.name AS user_name, u.email AS user_email,
                  u.twofa_enabled AS user_twofa_enabled
           FROM twofa_disable_requests t
           JOIN users u ON u.id = t.user_id
           WHERE t.status = ?
           ORDER BY t.id DESC
           LIMIT 100`,
          [filter === 'PENDING' ? 'PENDING' : filter]
        );
      }
    } catch (e) {
      if (e?.code === 'ER_NO_SUCH_TABLE') return res.json([]);
      throw e;
    }
    res.json(rows.map(mapDisableRequest));
  })
);

/**
 * POST /api/admin/2fa/disable-requests/:id/approve — admin only.
 * Approves the request: an enabled authenticator is turned OFF; accounts
 * that never enabled it are exempted from mandatory setup instead. Either
 * way the account keeps full ledger access without 2FA.
 */
router.post(
  '/2fa/disable-requests/:id/approve',
  ah(async (req, res) => {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) throw badRequest('Invalid request id');
    const found = await getDisableRequest(requestId);
    if (!found) throw notFound('Request not found');
    if (found.status !== 'PENDING') {
      throw badRequest(`Request is already ${String(found.status).toLowerCase()}.`);
    }
    await disableUserTwofa(found.user_id);
    await pool.query(
      'UPDATE twofa_disable_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?',
      ['APPROVED', new Date(), req.user.id, requestId]
    );
    res.json(mapDisableRequest(await getDisableRequest(requestId)));
  })
);

/**
 * POST /api/admin/2fa/disable-requests/:id/reject — admin only.
 * Body: { note?: string } — rejects the request; the user's 2FA stays ON.
 */
router.post(
  '/2fa/disable-requests/:id/reject',
  ah(async (req, res) => {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) throw badRequest('Invalid request id');
    const noteRaw = req.body?.note != null ? String(req.body.note).trim() : '';
    if (noteRaw.length > 1000) throw badRequest('Note is too long (max 1000 chars).');
    const found = await getDisableRequest(requestId);
    if (!found) throw notFound('Request not found');
    if (found.status !== 'PENDING') {
      throw badRequest(`Request is already ${String(found.status).toLowerCase()}.`);
    }
    await pool.query(
      'UPDATE twofa_disable_requests SET status = ?, admin_note = ?, decided_at = ?, decided_by = ? WHERE id = ?',
      ['REJECTED', noteRaw === '' ? null : noteRaw.slice(0, 1000), new Date(), req.user.id, requestId]
    );
    res.json(mapDisableRequest(await getDisableRequest(requestId)));
  })
);

/**
 * PATCH /api/admin/users/:id/2fa-exempt — admin only.
 * Body: { exempt: boolean }
 * - exempt=false → re-require the authenticator (clears an approval; an
 *   overdue account is blocked from ledger data until they enable 2FA again).
 * - exempt=true → directly disable 2FA + exempt (same effect as approving a
 *   request; useful when the user is locked out and cannot request).
 * Admin accounts (incl. yourself) cannot be changed here — use a request flow.
 */
router.patch(
  '/users/:id/2fa-exempt',
  ah(async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) throw badRequest('Invalid user id');
    const { exempt } = req.body ?? {};
    if (typeof exempt !== 'boolean') throw badRequest('`exempt` must be true or false');
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [targetId]);
    if (rows.length === 0) throw notFound('User not found');
    if (rows[0].is_admin) throw badRequest('Admin accounts cannot be changed here.');
    if (exempt) {
      await disableUserTwofa(targetId);
    } else {
      try {
        await pool.query('UPDATE users SET twofa_exempt = 0 WHERE id = ?', [targetId]);
      } catch (e) {
        if (e?.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
    }
    let refreshed;
    try {
      [refreshed] = await pool.query(
        `SELECT id, name, email, avatar_url, is_admin, is_suspended,
                suspension_reason, suspended_at, twofa_enabled, twofa_exempt, created_at
         FROM users WHERE id = ?`,
        [targetId]
      );
    } catch (e) {
      if (e?.code !== 'ER_BAD_FIELD_ERROR') throw e;
      [refreshed] = await pool.query(
        `SELECT id, name, email, avatar_url, is_admin, is_suspended,
                suspension_reason, suspended_at, twofa_enabled, created_at
         FROM users WHERE id = ?`,
        [targetId]
      );
    }
    res.json(mapAdminUser(refreshed[0]));
  })
);

/* ------------------------------------------------------------------ */
/* Tracking: let the admin see / track any other account's ledger data */
/* ------------------------------------------------------------------ */

async function ensureTargetUser(targetId) {
  if (!Number.isInteger(targetId) || targetId <= 0) throw badRequest('Invalid user id');
  const [rows] = await pool.query('SELECT id FROM users WHERE id = ?', [targetId]);
  if (rows.length === 0) throw notFound('User not found');
}

async function userCapitalSnapshot(userId) {
  const [[cap]] = await pool.query(
    'SELECT starting_capital FROM capital_settings WHERE user_id = ?',
    [userId]
  );
  const [[sales]] = await pool.query(
    'SELECT COALESCE(SUM(total_selling_price),0) AS revenue, COALESCE(SUM(profit_loss),0) AS profit, COUNT(*) AS count FROM sales WHERE user_id = ?',
    [userId]
  );
  const [[purch]] = await pool.query(
    'SELECT COALESCE(SUM(total_cost),0) AS cost, COALESCE(SUM(grams_bought),0) AS bought, COALESCE(SUM(grams_remaining),0) AS remaining, COUNT(*) AS count FROM batches WHERE user_id = ?',
    [userId]
  );
  const [[exp]] = await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM expenditures WHERE user_id = ?',
    [userId]
  );
  const [[wd]] = await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM withdrawals WHERE user_id = ?',
    [userId]
  );
  const [[loans]] = await pool.query(
    `SELECT COALESCE(SUM(amount_given),0) AS given,
            COALESCE(SUM(amount_repaid),0) AS repaid,
            COALESCE(SUM(amount_given - amount_repaid),0) AS outstanding,
            COUNT(*) AS count
     FROM loans WHERE user_id = ? AND status != 'REPAID'`,
    [userId]
  );
  const [[loansAll]] = await pool.query(
    'SELECT COUNT(*) AS count FROM loans WHERE user_id = ?',
    [userId]
  );
  let added = 0;
  try {
    const [[row]] = await pool.query(
      'SELECT COALESCE(SUM(amount),0) AS total FROM capital_additions WHERE user_id = ?',
      [userId]
    );
    added = num(row?.total);
  } catch {
    added = 0;
  }
  const startingCapital = num(cap?.starting_capital);
  const manualAdditions = added;
  const salesRevenue = num(sales?.revenue);
  const salesProfit = num(sales?.profit);
  const purchaseCost = num(purch?.cost);
  const expenditures = num(exp?.total);
  const withdrawals = num(wd?.total);
  const loansOutstanding = num(loans?.outstanding);
  const currentCapital =
    startingCapital + manualAdditions + salesRevenue - purchaseCost - expenditures - withdrawals - loansOutstanding;
  return {
    startingCapital,
    manualAdditions,
    addedCapital: manualAdditions,
    salesRevenue,
    salesProfit,
    purchaseCost,
    expenditures,
    withdrawals,
    loansOutstanding,
    loansGiven: num(loans?.given),
    loansRepaid: num(loans?.repaid),
    currentCapital,
    total: currentCapital,
    counts: {
      batches: num(purch?.count),
      sales: num(sales?.count),
      loans: num(loansAll?.count),
      expenditures: num(exp?.count),
      withdrawals: num(wd?.count),
      gramsBought: num(purch?.bought),
      gramsRemaining: num(purch?.remaining),
    },
    breakdown: {
      starting: startingCapital,
      added: manualAdditions,
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
 * GET /api/admin/overview — platform-wide totals across all non-admin accounts.
 * Used for the cards at the top of the admin page.
 */
router.get(
  '/overview',
  ah(async (req, res) => {
    const [[users]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(is_suspended) AS suspended,
              SUM(is_admin) AS admins
       FROM users`
    );
    const [[sales]] = await pool.query(
      'SELECT COALESCE(SUM(total_selling_price),0) AS revenue, COALESCE(SUM(profit_loss),0) AS profit, COUNT(*) AS count FROM sales'
    );
    const [[purch]] = await pool.query(
      'SELECT COALESCE(SUM(total_cost),0) AS cost, COUNT(*) AS count FROM batches'
    );
    const [[exp]] = await pool.query(
      'SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM expenditures'
    );
    const [[wd]] = await pool.query(
      'SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM withdrawals'
    );
    const [[loans]] = await pool.query(
      `SELECT COALESCE(SUM(amount_given - amount_repaid),0) AS outstanding,
              COALESCE(SUM(amount_given),0) AS given, COUNT(*) AS count
       FROM loans WHERE status != 'REPAID'`
    );
    const total = num(users?.total);
    const admins = num(users?.admins);
    const suspended = num(users?.suspended);
    res.json({
      totalUsers: total,
      adminCount: admins,
      regularUsers: total - admins,
      activeUsers: total - suspended,
      suspendedUsers: suspended,
      totalRevenue: num(sales?.revenue),
      totalProfit: num(sales?.profit),
      totalSales: num(sales?.count),
      totalPurchaseCost: num(purch?.cost),
      totalBatches: num(purch?.count),
      totalExpenditures: num(exp?.total),
      totalExpenditureCount: num(exp?.count),
      totalWithdrawals: num(wd?.total),
      totalWithdrawalCount: num(wd?.count),
      loansOutstanding: num(loans?.outstanding),
      loansGiven: num(loans?.given),
      openLoans: num(loans?.count),
    });
  })
);

/**
 * GET /api/admin/users/:id/summary — one account's KPI snapshot + row counts.
 */
router.get(
  '/users/:id/summary',
  ah(async (req, res) => {
    const targetId = Number(req.params.id);
    await ensureTargetUser(targetId);
    res.json(await userCapitalSnapshot(targetId));
  })
);

/**
 * GET /api/admin/users/:id/capital — snapshot + manual top-up history.
 */
router.get(
  '/users/:id/capital',
  ah(async (req, res) => {
    const targetId = Number(req.params.id);
    await ensureTargetUser(targetId);
    const snapshot = await userCapitalSnapshot(targetId);
    let additions = [];
    try {
      const [rows] = await pool.query(
        'SELECT id, amount, note, created_at AS createdAt FROM capital_additions WHERE user_id = ? ORDER BY id DESC LIMIT 100',
        [targetId]
      );
      additions = rows.map((r) => ({
        id: r.id,
        amount: Number(r.amount),
        note: r.note,
        createdAt: r.createdAt,
      }));
    } catch (e) {
      if (e?.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    res.json({ ...snapshot, additions });
  })
);

/** GET /api/admin/users/:id/batches — that account's batches, newest first. */
router.get(
  '/users/:id/batches',
  ah(async (req, res) => {
    const targetId = Number(req.params.id);
    await ensureTargetUser(targetId);
    const [rows] = await pool.query(
      'SELECT * FROM batches WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
      [targetId]
    );
    res.json(rows.map(mapBatch));
  })
);

/** GET /api/admin/users/:id/sales — that account's sales, newest first. */
router.get(
  '/users/:id/sales',
  ah(async (req, res) => {
    const targetId = Number(req.params.id);
    await ensureTargetUser(targetId);
    const [rows] = await pool.query(
      `SELECT s.*, b.batch_number FROM sales s
       JOIN batches b ON b.id = s.batch_id
       WHERE s.user_id = ? ORDER BY s.sale_date DESC, s.id DESC LIMIT 200`,
      [targetId]
    );
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const [items] = await pool.query(
        `SELECT sb.sale_id, sb.batch_id, b.batch_number
         FROM sale_batches sb JOIN batches b ON b.id = sb.batch_id
         WHERE sb.sale_id IN (?) ORDER BY sb.id ASC`,
        [ids]
      );
      const bySale = new Map();
      for (const it of items) {
        if (!bySale.has(it.sale_id)) bySale.set(it.sale_id, []);
        bySale.get(it.sale_id).push(it);
      }
      for (const r of rows) {
        const list = bySale.get(r.id);
        if (list?.length) {
          r.batch_ids = list.map((x) => x.batch_id);
          r.batch_numbers = list.map((x) => x.batch_number);
        }
      }
    }
    res.json(rows.map(mapSale));
  })
);

/** GET /api/admin/users/:id/loans — that account's loans, newest first. */
router.get(
  '/users/:id/loans',
  ah(async (req, res) => {
    const targetId = Number(req.params.id);
    await ensureTargetUser(targetId);
    const [rows] = await pool.query(
      'SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
      [targetId]
    );
    res.json(rows.map(mapLoan));
  })
);

/** GET /api/admin/users/:id/expenditures — that account's expenses. */
router.get(
  '/users/:id/expenditures',
  ah(async (req, res) => {
    const targetId = Number(req.params.id);
    await ensureTargetUser(targetId);
    const [rows] = await pool.query(
      'SELECT * FROM expenditures WHERE user_id = ? ORDER BY expense_date DESC, id DESC LIMIT 200',
      [targetId]
    );
    res.json(rows.map(mapExpenditure));
  })
);

/** GET /api/admin/users/:id/withdrawals — that account's withdrawals. */
router.get(
  '/users/:id/withdrawals',
  ah(async (req, res) => {
    const targetId = Number(req.params.id);
    await ensureTargetUser(targetId);
    const [rows] = await pool.query(
      'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY withdrawal_date DESC, id DESC LIMIT 200',
      [targetId]
    );
    res.json(rows.map(mapWithdrawal));
  })
);

export default router;
