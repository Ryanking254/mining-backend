import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { OAuth2Client } from 'google-auth-library';
import { pool } from '../db.js';
import { ah, badRequest, notFound } from '../utils.js';
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
  createdAt: r.created_at,
});

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

/**
 * POST /api/auth/register
 * Body: { name, email, password }
 * First registered user becomes the admin; subsequent registrations are allowed
 * (single-tenant ledger — gate with ALLOW_PUBLIC_REGISTER=false to disable).
 */
router.post(
  '/register',
  ah(async (req, res) => {
    const { name, email, password } = req.body ?? {};

    if (!name || String(name).trim() === '') throw badRequest('name is required');
    if (!validateEmail(email)) throw badRequest('valid email is required');
    if (typeof password !== 'string' || password.length < 6) {
      throw badRequest('password must be at least 6 characters');
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
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
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
    } else if (avatar && !row.avatar_url) {
      await pool.query('UPDATE users SET avatar_url = ? WHERE id = ?', [avatar, row.id]);
      row.avatar_url = avatar;
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
router.get('/2fa/status', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT twofa_enabled, twofa_backup_codes FROM users WHERE id = ?', [
    req.user.id,
  ]);
  if (rows.length === 0) throw notFound('User not found');
  res.json({
    enabled: !!rows[0].twofa_enabled,
    backupCodesRemaining: parseBackupHashes(rows[0]).length,
  });
});

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
    await pool.query('UPDATE users SET twofa_enabled = 1, twofa_backup_codes = ? WHERE id = ?', [
      JSON.stringify(backupCodes.map(hashBackupCode)),
      row.id,
    ]);
    const [refreshed] = await pool.query('SELECT * FROM users WHERE id = ?', [row.id]);
    res.json({ enabled: true, backupCodes, user: mapUser(refreshed[0]) });
  })
);

/**
 * POST /api/auth/2fa/disable — Body: { code } or { password }.
 * Requires a current TOTP code (or the account password) to disable.
 */
router.post(
  '/2fa/disable',
  requireAuth,
  ah(async (req, res) => {
    const { code, password } = req.body ?? {};
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) throw notFound('User not found');
    const row = rows[0];
    if (!row.twofa_enabled) return res.json({ disabled: true });

    let ok = false;
    if (typeof code === 'string' && code.trim() !== '' && row.twofa_secret) {
      ok = speakeasy.totp.verify({
        secret: row.twofa_secret,
        encoding: 'base32',
        token: String(code).trim(),
        window: 1,
      });
    }
    if (!ok && typeof password === 'string' && password !== '' && row.password_hash) {
      ok = await bcrypt.compare(password, row.password_hash);
    }
    // Also accept a backup code for recovery.
    if (!ok && typeof code === 'string' && code.trim() !== '') {
      const candidate = String(code).trim().toUpperCase().replace(/[\s-]/g, '');
      const hashes = parseBackupHashes(row);
      if (hashes.includes(hashBackupCode(candidate))) ok = true;
    }
    if (!ok) return res.status(401).json({ error: 'Invalid code or password' });

    await pool.query(
      'UPDATE users SET twofa_enabled = 0, twofa_secret = NULL, twofa_backup_codes = NULL WHERE id = ?',
      [row.id]
    );
    res.json({ disabled: true });
  })
);

/** GET /api/auth/me — requires Bearer token */
router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (rows.length === 0) throw notFound('User not found');
  res.json(mapUser(rows[0]));
});

export default router;
