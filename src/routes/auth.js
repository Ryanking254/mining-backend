import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { OAuth2Client } from 'google-auth-library';
import { pool } from '../db.js';
import { ah, badRequest, notFound, twofaGraceState } from '../utils.js';
import { signToken, signPendingToken, verifyPendingToken } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const mapUser = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  avatarUrl: r.avatar_url ?? null,
  hasPassword: !!r.password_hash,
  googleLinked: !!r.google_id,
  twofaEnabled: !!r.twofa_enabled,
  twofaExempt: !!(r.twofa_exempt ?? 0),
  createdAt: r.created_at,
  isAdmin: !!(r.is_admin ?? 0),
  isSuspended: !!(r.is_suspended ?? 0),
  suspensionReason: r.suspension_reason ?? null,
});

function getAdminEmails() {
  return String(process.env.ADMIN_EMAIL ?? process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isAdminEmail(email) {
  return getAdminEmails().includes(String(email || '').trim().toLowerCase());
}

/** Promote matching ADMIN_EMAIL accounts (bootstrap for the owner). Best-effort. */
async function maybePromoteAdmin(userId, email) {
  try {
    if (isAdminEmail(email)) {
      await pool.query('UPDATE users SET is_admin = 1 WHERE id = ?', [userId]);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function getGoogleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    const err = new Error(
      'Google sign-in is not configured (GOOGLE_CLIENT_ID is missing on the server)'
    );
    err.status = 500;
    throw err;
  }
  return new OAuth2Client(clientId);
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(5).toString('hex').toUpperCase()); // 10 chars
  }
  return codes;
}

function parseBackupHashes(row) {
  try {
    const v = JSON.parse(row.twofa_backup_codes || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/* ---- 2FA disable requests (user asks, admin approves, 2FA stays ON meanwhile) ---- */

const DISABLE_REQUESTS_DDL = `CREATE TABLE IF NOT EXISTS twofa_disable_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  reason VARCHAR(1000) NULL,
  admin_note VARCHAR(1000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMP NULL,
  decided_by INT NULL,
  INDEX idx_tdr_user (user_id),
  INDEX idx_tdr_status (status),
  CONSTRAINT fk_tdr_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
)`;

/** Best-effort: make sure the requests table exists (migrate usually covers it). */
async function ensureDisableRequestsTable() {
  try {
    await pool.query(DISABLE_REQUESTS_DDL);
  } catch {
    /* ignore — callers fall back to degraded behaviour */
  }
}

const mapDisableRequest = (r) => ({
  id: r.id,
  userId: r.user_id,
  status: r.status,
  reason: r.reason ?? null,
  adminNote: r.admin_note ?? null,
  createdAt: r.created_at,
  decidedAt: r.decided_at ?? null,
  decidedBy: r.decided_by ?? null,
});

async function getPendingDisableRequest(userId) {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM twofa_disable_requests WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT 1',
      [userId, 'PENDING']
    );
    return rows[0] || null;
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      await ensureDisableRequestsTable();
      return null;
    }
    throw e;
  }
}

/**
 * POST /api/auth/register
 * Body: { name, email, password, startingCapital? }
 * `startingCapital` (optional, >= 0) seeds this account's starting capital so
 * a new user can declare their opening balance during signup.
 * First registered user becomes the admin; subsequent registrations are allowed
 * (single-tenant ledger — gate with ALLOW_PUBLIC_REGISTER=false to disable).
 */
router.post(
  '/register',
  ah(async (req, res) => {
    const { name, email, password } = req.body ?? {};
    const rawStarting =
      req.body?.startingCapital ?? req.body?.starting_capital ?? req.body?.startingAmount;

    if (!name || String(name).trim() === '') throw badRequest('name is required');
    if (!validateEmail(email)) throw badRequest('valid email is required');
    if (typeof password !== 'string' || password.length < 6) {
      throw badRequest('password must be at least 6 characters');
    }
    let startingCapital = 0;
    if (rawStarting !== undefined && rawStarting !== '' && rawStarting !== null) {
      startingCapital = Number(rawStarting);
      if (!Number.isFinite(startingCapital) || startingCapital < 0) {
        throw badRequest('startingCapital must be a non-negative number');
      }
    }

    const allowPublic =
      String(process.env.ALLOW_PUBLIC_REGISTER ?? 'true').toLowerCase() !== 'false';
    if (!allowPublic) {
      const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM users');
      if (Number(count) > 0) {
        return res.status(403).json({ error: 'Registration is disabled' });
      }
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [String(name).trim(), normalizedEmail, passwordHash]
    );
    // Each account owns its ledger + capital. Seed the starting capital given at signup.
    try {
      await pool.query(
        'INSERT INTO capital_settings (user_id, starting_capital) VALUES (?, ?) ON DUPLICATE KEY UPDATE starting_capital = ?',
        [result.insertId, startingCapital, startingCapital]
      );
    } catch {
      /* ignore — capital endpoints lazily create the row */
    }
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
    if (isAdminEmail(normalizedEmail)) {
      await maybePromoteAdmin(result.insertId, normalizedEmail);
      const [refreshed] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
      if (refreshed[0]) {
        const user = mapUser(refreshed[0]);
        res.status(201).json({ user, token: signToken(user) });
        return;
      }
    }
    const user = mapUser(rows[0]);
    res.status(201).json({ user, token: signToken(user) });
  })
);

/** POST /api/auth/login — Body: { email, password } */
router.post(
  '/login',
  ah(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!validateEmail(email)) throw badRequest('valid email is required');
    if (typeof password !== 'string' || password === '') throw badRequest('password is required');

    const normalizedEmail = String(email).trim().toLowerCase();
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const row = rows[0];
    if (!row.password_hash) {
      return res
        .status(401)
        .json({ error: 'This account uses Google sign-in. Please continue with Google.' });
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Owner bootstrap — ADMIN_EMAIL always lands as admin, even on older rows.
    if (isAdminEmail(row.email) && !row.is_admin) {
      await maybePromoteAdmin(row.id, row.email);
      row.is_admin = 1;
    }
    // 2FA gate — don't issue a full session yet.
    if (row.twofa_enabled) {
      return res.json({ requires2fa: true, pendingToken: signPendingToken(row.id) });
    }
    const user = mapUser(row);
    res.json({ user, token: signToken(user) });
  })
);

/**
 * POST /api/auth/google — Body: { idToken } (Google Identity Services credential)
 * Verifies the Google ID token, creates/links the user, then either returns a
 * session or a 2FA pending token.
 */
router.post(
  '/google',
  ah(async (req, res) => {
    const idToken = req.body?.idToken ?? req.body?.credential ?? req.body?.token;
    if (typeof idToken !== 'string' || idToken === '') {
      throw badRequest('idToken is required');
    }
    const client = getGoogleClient();
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: 'Invalid Google credential' });
    }
    if (!payload?.email || payload.email_verified === false) {
      return res.status(401).json({ error: 'Google email could not be verified' });
    }

    const googleId = String(payload.sub);
    const email = String(payload.email).trim().toLowerCase();
    const name = String(payload.name || payload.given_name || email.split('@')[0]).trim();
    const avatar = typeof payload.picture === 'string' ? payload.picture : null;

    // Prefer google_id match, fall back to email (account linking).
    let [rows] = await pool.query('SELECT * FROM users WHERE google_id = ?', [googleId]);
    let row = rows[0];
    if (!row) {
      [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
      row = rows[0];
      if (row) {
        // Link this Google identity to the existing email account.
        await pool.query('UPDATE users SET google_id = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?', [
          googleId,
          avatar,
          row.id,
        ]);
        const [refreshed] = await pool.query('SELECT * FROM users WHERE id = ?', [row.id]);
        row = refreshed[0];
      }
    }
    if (!row) {
      const allowPublic =
        String(process.env.ALLOW_PUBLIC_REGISTER ?? 'true').toLowerCase() !== 'false';
      if (!allowPublic) {
        const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM users');
        if (Number(count) > 0) {
          return res.status(403).json({ error: 'Registration is disabled' });
        }
      }
      const [result] = await pool.query(
        'INSERT INTO users (name, email, password_hash, google_id, avatar_url) VALUES (?, ?, NULL, ?, ?)',
        [name || 'Google user', email, googleId, avatar]
      );
      const [created] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
      row = created[0];
      // Seed per-account capital for brand-new Google accounts (lazy default 0
      // unless the client supplied an opening balance).
      try {
        const rawStarting = req.body?.startingCapital ?? req.body?.starting_capital;
        const startVal =
          rawStarting !== undefined && rawStarting !== '' && rawStarting !== null
            ? Number(rawStarting)
            : 0;
        const safeStart = Number.isFinite(startVal) && startVal >= 0 ? startVal : 0;
        await pool.query('INSERT IGNORE INTO capital_settings (user_id, starting_capital) VALUES (?, ?)', [
          row.id,
          safeStart,
        ]);
      } catch {
        /* ignore */
      }
    } else if (avatar && !row.avatar_url) {
      await pool.query('UPDATE users SET avatar_url = ? WHERE id = ?', [avatar, row.id]);
      row.avatar_url = avatar;
    }
    if (isAdminEmail(row.email) && !row.is_admin) {
      await maybePromoteAdmin(row.id, row.email);
      row.is_admin = 1;
    }

    if (row.twofa_enabled) {
      return res.json({ requires2fa: true, pendingToken: signPendingToken(row.id) });
    }
    const user = mapUser(row);
    res.json({ user, token: signToken(user) });
  })
);

/**
 * POST /api/auth/2fa/verify-login — Body: { pendingToken, code } or { pendingToken, backupCode }
 * Completes a password/Google login when 2FA is enabled.
 */
router.post(
  '/2fa/verify-login',
  ah(async (req, res) => {
    const { pendingToken, code, backupCode } = req.body ?? {};
    if (typeof pendingToken !== 'string' || pendingToken === '') {
      throw badRequest('pendingToken is required');
    }
    let pending;
    try {
      pending = verifyPendingToken(pendingToken);
    } catch {
      return res.status(401).json({ error: 'Expired or invalid 2FA session. Please sign in again.' });
    }
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [pending.id]);
    if (rows.length === 0) return res.status(401).json({ error: 'User not found' });
    const row = rows[0];

    // If 2FA was disabled mid-flow, just issue the session.
    if (!row.twofa_enabled || !row.twofa_secret) {
      const user = mapUser(row);
      return res.json({ user, token: signToken(user) });
    }

    const otp = code != null ? String(code).trim() : '';
    const backup = backupCode != null ? String(backupCode).trim().toUpperCase().replace(/[\s-]/g, '') : '';

    if (otp !== '') {
      const verified = speakeasy.totp.verify({
        secret: row.twofa_secret,
        encoding: 'base32',
        token: otp,
        window: 1,
      });
      if (!verified) return res.status(401).json({ error: 'Invalid authenticator code' });
    } else if (backup !== '') {
      const hashes = parseBackupHashes(row);
      const digest = hashBackupCode(backup);
      const idx = hashes.indexOf(digest);
      if (idx === -1) return res.status(401).json({ error: 'Invalid backup code' });
      // Consume the backup code (single-use).
      hashes.splice(idx, 1);
      await pool.query('UPDATE users SET twofa_backup_codes = ? WHERE id = ?', [
        JSON.stringify(hashes),
        row.id,
      ]);
    } else {
      throw badRequest('code is required');
    }

    const user = mapUser(row);
    res.json({ user, token: signToken(user) });
  })
);

/** GET /api/auth/2fa/status — requires Bearer token */
router.get('/2fa/status', requireAuth, ah(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT twofa_enabled, twofa_backup_codes, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  if (rows.length === 0) throw notFound('User not found');
  let exempt = false;
  try {
    const [ex] = await pool.query('SELECT twofa_exempt FROM users WHERE id = ?', [req.user.id]);
    exempt = !!ex[0]?.twofa_exempt;
  } catch (e) {
    if (e?.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  const grace = twofaGraceState({ twofa_enabled: rows[0].twofa_enabled, created_at: rows[0].created_at });
  let pendingRequest = null;
  try {
    const pending = await getPendingDisableRequest(req.user.id);
    if (pending) pendingRequest = mapDisableRequest(pending);
  } catch {
    pendingRequest = null;
  }
  res.json({
    enabled: !!rows[0].twofa_enabled,
    exempt,
    backupCodesRemaining: parseBackupHashes(rows[0]).length,
    // Exempt accounts (2FA disabled with admin approval) are not forced to re-enable.
    required: exempt ? false : grace.required,
    overdue: exempt ? false : grace.overdue,
    graceDays: grace.graceDays,
    daysLeft: exempt ? 0 : grace.daysLeft,
    deadline: exempt ? null : grace.deadline,
    disableRequest: pendingRequest,
  });
}));

/**
 * POST /api/auth/2fa/setup — requires Bearer token.
 * Generates a TOTP secret and QR code. Confirm with POST /2fa/confirm.
 */
router.post(
  '/2fa/setup',
  requireAuth,
  ah(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) throw notFound('User not found');
    const row = rows[0];

    const secret = speakeasy.generateSecret({
      name: `Mining Ledger (${row.email})`,
      issuer: 'Mining Ledger',
      length: 20,
    });
    await pool.query('UPDATE users SET twofa_secret = ? WHERE id = ?', [secret.base32, row.id]);
    const otpauthUrl = secret.otpauth_url;
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    res.json({ secret: secret.base32, otpauthUrl, qrDataUrl });
  })
);

/**
 * POST /api/auth/2fa/confirm — Body: { code }. Verifies the code against the
 * pending secret, enables 2FA and returns single-use backup codes.
 */
router.post(
  '/2fa/confirm',
  requireAuth,
  ah(async (req, res) => {
    const { code } = req.body ?? {};
    if (typeof code !== 'string' || code.trim() === '') throw badRequest('code is required');
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) throw notFound('User not found');
    const row = rows[0];
    if (!row.twofa_secret) throw badRequest('No 2FA setup in progress. Call POST /2fa/setup first.');

    const verified = speakeasy.totp.verify({
      secret: row.twofa_secret,
      encoding: 'base32',
      token: String(code).trim(),
      window: 1,
    });
    if (!verified) return res.status(400).json({ error: 'Invalid code. Check your authenticator app time and try again.' });

    const backupCodes = generateBackupCodes(10);
    const backupJson = JSON.stringify(backupCodes.map(hashBackupCode));
    try {
      // Re-enabling clears any admin-granted exemption.
      await pool.query('UPDATE users SET twofa_enabled = 1, twofa_backup_codes = ?, twofa_exempt = 0 WHERE id = ?', [
        backupJson,
        row.id,
      ]);
    } catch (e) {
      if (e?.code === 'ER_BAD_FIELD_ERROR') {
        // Older DBs without the twofa_exempt column.
        await pool.query('UPDATE users SET twofa_enabled = 1, twofa_backup_codes = ? WHERE id = ?', [
          backupJson,
          row.id,
        ]);
      } else {
        throw e;
      }
    }
    const [refreshed] = await pool.query('SELECT * FROM users WHERE id = ?', [row.id]);
    res.json({ enabled: true, backupCodes, user: mapUser(refreshed[0]) });
  })
);

/**
 * POST /api/auth/2fa/disable-request — requires Bearer token.
 * Body: { reason?: string }
 * Asks an admin to lift the authenticator requirement. Works for EVERY
 * non-exempt account:
 * - 2FA enabled → request to turn it OFF (stays ON until approved).
 * - 2FA never enabled (incl. overdue accounts blocked from the ledger) →
 *   request an exemption from mandatory setup (stays blocked until approved).
 * One PENDING request per user; repeat calls return the existing one (409).
 */
router.post(
  '/2fa/disable-request',
  requireAuth,
  ah(async (req, res) => {
    const [rows] = await pool.query('SELECT twofa_enabled FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) throw notFound('User not found');
    let exempt = false;
    try {
      const [ex] = await pool.query('SELECT twofa_exempt FROM users WHERE id = ?', [req.user.id]);
      exempt = !!ex[0]?.twofa_exempt;
    } catch (e) {
      if (e?.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
    if (exempt) {
      throw badRequest('Two-factor authentication is already disabled with admin approval.');
    }
    const had2fa = !!rows[0].twofa_enabled;
    const reasonRaw = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (reasonRaw.length > 1000) throw badRequest('Reason is too long (max 1000 chars).');
    await ensureDisableRequestsTable();
    const existing = await getPendingDisableRequest(req.user.id);
    if (existing) {
      return res.status(409).json({
        error: 'You already have a pending request. Nothing changes until an admin approves.',
        request: mapDisableRequest(existing),
      });
    }
    const [result] = await pool.query(
      'INSERT INTO twofa_disable_requests (user_id, status, reason) VALUES (?, ?, ?)',
      [req.user.id, 'PENDING', reasonRaw === '' ? null : reasonRaw.slice(0, 1000)]
    );
    const [created] = await pool.query('SELECT * FROM twofa_disable_requests WHERE id = ?', [result.insertId]);
    res.status(201).json({
      message: had2fa
        ? 'Request sent. Your authenticator stays enabled until an admin approves.'
        : 'Request sent. The authenticator requirement stays in place until an admin approves.',
      request: mapDisableRequest(created[0]),
    });
  })
);

/**
 * GET /api/auth/2fa/disable-requests — own request history (newest first).
 * Requires Bearer token.
 */
router.get(
  '/2fa/disable-requests',
  requireAuth,
  ah(async (req, res) => {
    await ensureDisableRequestsTable();
    let rows;
    try {
      [rows] = await pool.query(
        'SELECT * FROM twofa_disable_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20',
        [req.user.id]
      );
    } catch (e) {
      if (e?.code === 'ER_NO_SUCH_TABLE') return res.json([]);
      throw e;
    }
    res.json(rows.map(mapDisableRequest));
  })
);

/**
 * DELETE /api/auth/2fa/disable-request — cancel your own PENDING request.
 * Requires Bearer token. 2FA stays enabled (nothing changes except the request).
 */
router.delete(
  '/2fa/disable-request',
  requireAuth,
  ah(async (req, res) => {
    await ensureDisableRequestsTable();
    const pending = await getPendingDisableRequest(req.user.id);
    if (!pending) throw notFound('No pending disable request.');
    await pool.query(
      "UPDATE twofa_disable_requests SET status = 'CANCELLED', decided_at = ? WHERE id = ?",
      [new Date(), pending.id]
    );
    const [refreshed] = await pool.query('SELECT * FROM twofa_disable_requests WHERE id = ?', [pending.id]);
    res.json({ cancelled: true, request: mapDisableRequest(refreshed[0]) });
  })
);

/**
 * POST /api/auth/2fa/disable — direct disable, ADMIN ONLY (own account).
 * Admins have no higher authority to approve them, so they may turn off
 * their own authenticator directly. Everyone else gets a 403 and must use
 * POST /2fa/disable-request instead.
 */
router.post(
  '/2fa/disable',
  requireAuth,
  ah(async (req, res) => {
    const [rows] = await pool.query('SELECT is_admin, twofa_enabled FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) throw notFound('User not found');
    if (!rows[0].is_admin) {
      return res.status(403).json({ error: 'Disabling two-factor authentication needs admin approval. Please send a disable request first.' });
    }
    if (!rows[0].twofa_enabled) throw badRequest('Two-factor authentication is not enabled.');
    try {
      await pool.query(
        'UPDATE users SET twofa_enabled = 0, twofa_secret = NULL, twofa_backup_codes = NULL, twofa_exempt = 1 WHERE id = ?',
        [req.user.id]
      );
    } catch (e) {
      if (e?.code === 'ER_BAD_FIELD_ERROR') {
        // Older DBs without twofa_exempt — still turn 2FA off.
        await pool.query(
          'UPDATE users SET twofa_enabled = 0, twofa_secret = NULL, twofa_backup_codes = NULL WHERE id = ?',
          [req.user.id]
        );
      } else {
        throw e;
      }
    }
    const [refreshed] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json({ disabled: true, user: mapUser(refreshed[0]) });
  })
);

/** GET /api/auth/me — requires Bearer token */
router.get('/me', requireAuth, ah(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (rows.length === 0) throw notFound('User not found');
  if (isAdminEmail(rows[0].email) && !rows[0].is_admin) {
    await maybePromoteAdmin(rows[0].id, rows[0].email);
    const [refreshed] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(mapUser(refreshed[0]));
    return;
  }
  res.json(mapUser(rows[0]));
}));

export default router;
