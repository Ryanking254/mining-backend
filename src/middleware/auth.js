import jwt from 'jsonwebtoken';

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
