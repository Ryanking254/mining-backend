import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { ah, badRequest, notFound } from '../utils.js';
import { signToken } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const mapUser = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  createdAt: r.created_at,
});

function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
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
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = mapUser(row);
    res.json({ user, token: signToken(user) });
  })
);

/** GET /api/auth/me — requires Bearer token */
router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (rows.length === 0) throw notFound('User not found');
  res.json(mapUser(rows[0]));
});

export default router;
