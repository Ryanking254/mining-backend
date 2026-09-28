import { Router } from 'express';
import { pool } from '../db.js';
import { ah, badRequest, notFound } from '../utils.js';

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
  createdAt: r.created_at,
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
                suspension_reason, suspended_at, twofa_enabled, created_at
         FROM users ORDER BY id ASC`
      );
    } catch (e) {
      // Older DBs without the admin columns — select the base columns and
      // synthesize defaults so the admin page doesn't 500 before migrate runs.
      if (e?.code === 'ER_BAD_FIELD_ERROR') {
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
              suspension_reason, suspended_at, twofa_enabled, created_at
       FROM users WHERE id = ?`,
      [targetId]
    );
    res.json(mapAdminUser(refreshed[0]));
  })
);

export default router;
