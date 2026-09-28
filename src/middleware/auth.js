import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { getTwofaGraceDays, parseDbDate } from '../utils.js';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is not set');
    }
    return 'dev-only-secret-change-me';
  }
  return secret;
}

export function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    getSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

/** Short-lived token issued after password/Google check when 2FA is enabled. */
export function signPendingToken(userId) {
  return jwt.sign({ id: userId, purpose: '2fa-pending' }, getSecret(), { expiresIn: '10m' });
}

export function verifyPendingToken(token) {
  const payload = jwt.verify(token, getSecret());
  if (!payload || payload.purpose !== '2fa-pending' || !payload.id) {
    throw new Error('Invalid pending token');
  }
  return payload;
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(token, getSecret());
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Admin-only gate — checks the live is_admin flag (not the JWT). */
export function requireAdmin(req, res, next) {
  Promise.resolve()
    .then(async () => {
      if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
      const [rows] = await pool.query(
        'SELECT is_admin FROM users WHERE id = ?',
        [req.user.id]
      );
      if (rows.length === 0) {
        const err = new Error('User not found');
        err.status = 404;
        throw err;
      }
      if (!rows[0].is_admin) {
        return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
      }
      req.isAdmin = true;
      return next();
    })
    .catch(next);
}

/**
 * Killswitch gate — blocks ledger data APIs for suspended accounts.
 * The frontend shows "Your services have been paused…" with the reason.
 * Auth + admin endpoints stay reachable so the user can still sign in and
 * see the message, and the admin can still manage them.
 */
export function enforceSuspension(req, res, next) {
  Promise.resolve()
    .then(async () => {
      if (!req.user?.id) return next();
      let rows;
      try {
        [rows] = await pool.query(
          'SELECT is_suspended, suspension_reason FROM users WHERE id = ?',
          [req.user.id]
        );
      } catch (e) {
        // Older DBs without the columns (migrate hasn't run yet) — don't
        // block everyone; treat as not suspended.
        if (e?.code === 'ER_BAD_FIELD_ERROR') return next();
        throw e;
      }
      if (rows.length === 0) {
        const err = new Error('User not found');
        err.status = 404;
        throw err;
      }
      if (rows[0].is_suspended) {
        return res.status(403).json({
          error: 'Your services have been paused. Please contact support.',
          code: 'ACCOUNT_SUSPENDED',
          reason: rows[0].suspension_reason || null,
        });
      }
      return next();
    })
    .catch(next);
}

/**
 * Block ledger data APIs once the authenticator grace period has expired.
 * Auth endpoints (setup/confirm/status/me) are intentionally NOT guarded so
 * an overdue user can still complete setup. Returns 403 with
 * code TWOFA_SETUP_REQUIRED when the user must enable the authenticator app.
 */
export function enforceTwofa(req, res, next) {
  Promise.resolve()
    .then(async () => {
      if (!req.user?.id) return next();
      const [rows] = await pool.query(
        'SELECT twofa_enabled, created_at FROM users WHERE id = ?',
        [req.user.id]
      );
      if (rows.length === 0) {
        const err = new Error('User not found');
        err.status = 404;
        throw err;
      }
      if (rows[0].twofa_enabled) return next();
      const graceDays = getTwofaGraceDays();
      const created = parseDbDate(rows[0].created_at);
      const deadline = created ? new Date(created.getTime() + graceDays * 86400000) : null;
      if (deadline && Date.now() > deadline.getTime()) {
        return res.status(403).json({
          error:
            'Authenticator app setup is required. Please enable two-factor authentication in Security to continue.',
          code: 'TWOFA_SETUP_REQUIRED',
          deadline: deadline.toISOString(),
        });
      }
      return next();
    })
    .catch(next);
}
