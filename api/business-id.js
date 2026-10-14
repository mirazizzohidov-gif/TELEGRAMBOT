import { checkSecret } from '../lib/request.js';

// Finds business_connection updates via getUpdates (works only while no webhook is set).
export default async function handler(req, res) {
if (req.method !== 'GET' && req.method !== 'POST') {
return res.status(405).json({ ok: false, error: 'Use GET or POST' });
}
const { BOT_TOKEN, SECRET } = process.env;
if (!BOT_TOKEN || !SECRET) {
return res.status(500).json({ ok: false, error: 'Missing environment variables' });
}
if (!checkSecret(req, res)) return;
try {
const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ allowed_updates: ['business_connection'] }),
});
const data = await tgRes.json();
if (!data.ok) {
return res.status(502).json({ ok: false, error: 'Telegram error', details: data });
}
const connections = data.result
.filter((u) => u.business_connection)
.map(({ business_connection: c }) => ({
id: c.id,
user: c.user,
rights: c.rights ?? null,
is_enabled: c.is_enabled,
date: c.date,
}));
return res.status(200).json({ ok: true, connections });
} catch (err) {
return res.status(500).json({ ok: false, error: String(err) });
}
}
