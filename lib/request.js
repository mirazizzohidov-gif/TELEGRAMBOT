// Returns true if the request is authorized; otherwise sends 401 and returns false.
export function checkSecret(req, res) {
  if (!process.env.SECRET || req.headers['x-secret'] !== process.env.SECRET) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Cron endpoints: Vercel sends "Authorization: Bearer <CRON_SECRET>"; x-secret also works.
export function checkCron(req, res) {
  const { CRON_SECRET, SECRET } = process.env;
  const bearerOk = CRON_SECRET && req.headers.authorization === `Bearer ${CRON_SECRET}`;
  const secretOk = SECRET && req.headers['x-secret'] === SECRET;
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
