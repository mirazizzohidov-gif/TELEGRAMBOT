import { timingSafeEqual } from 'node:crypto';

const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// The x-secret value: SECRET, and while it is being replaced also SECRET_OLD (ignored when empty).
// A request with the old one is logged, so it is clear when SECRET_OLD can be removed.
export function secretMatches(value) {
  const { SECRET, SECRET_OLD } = process.env;
  if (same(value, SECRET)) return true;
  if (same(value, SECRET_OLD)) {
    console.warn('auth: the OLD secret (SECRET_OLD) was used — update the caller, then remove SECRET_OLD');
    return true;
  }
  return false;
}

// Returns true if the request is authorized; otherwise sends 401 and returns false.
export function checkSecret(req, res) {
  if (!process.env.SECRET || !secretMatches(req.headers['x-secret'])) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Cron endpoints: Vercel sends "Authorization: Bearer <CRON_SECRET>"; x-secret also works.
export function checkCron(req, res) {
  const { CRON_SECRET, SECRET } = process.env;
  const bearerOk = Boolean(CRON_SECRET) && same(req.headers.authorization, `Bearer ${CRON_SECRET}`);
  const secretOk = Boolean(SECRET) && secretMatches(req.headers['x-secret']);
  if (!bearerOk && !secretOk) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Returns the parsed JSON body, or undefined after sending 400.
export function readBody(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return undefined;
    }
  }
  return body || {};
}
