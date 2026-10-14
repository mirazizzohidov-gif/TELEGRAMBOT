import { resolveProduct } from '../lib/bito.js';
import { buildCaption } from '../lib/caption.js';
import { checkSecret, readBody } from '../lib/request.js';

export default async function handler(req, res) {
if (req.method !== 'POST') {
return res.status(405).json({ ok: false, error: 'Use POST' });
}
const { BOT_TOKEN, CHANNEL_ID, SECRET, PROTECT_CONTENT } = process.env;
if (!BOT_TOKEN || !CHANNEL_ID || !SECRET) {
return res.status(500).json({ ok: false, error: 'Missing environment variables' });
}
if (!checkSecret(req, res)) return;
const body = readBody(req, res);
if (!body) return;
let product;
try {
product = await resolveProduct(body);
} catch (err) {
return res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
}
const caption = buildCaption(product.name, product.price);
try {
const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
chat_id: CHANNEL_ID,
photo: product.image_url,
caption,
protect_content: PROTECT_CONTENT !== 'false',
}),
});
const data = await tgRes.json();
if (!data.ok) {
return res.status(502).json({ ok: false, error: 'Telegram error', details: data });
}
return res.status(200).json({ ok: true, message_id: data.result.message_id, product });
} catch (err) {
return res.status(500).json({ ok: false, error: String(err) });
}
}
