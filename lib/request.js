// Returns true if the request is authorized; otherwise sends 401 and returns false.
export function checkSecret(req, res) {
if (req.headers['x-secret'] !== process.env.SECRET) {
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
