export default async function handler(req, res) {
if (req.method !== 'POST') {
return res.status(405).json({ ok: false, error: 'Use POST' });
}
const { BOT_TOKEN, CHANNEL_ID, SECRET } = process.env;
if (!BOT_TOKEN || !CHANNEL_ID || !SECRET) {
return res.status(500).json({ ok: false, error: 'Missing environment variables' });
}
if (req.headers['x-secret'] !== SECRET) {
return res.status(401).json({ ok: false, error: 'Unauthorized' });
}
let body = req.body;
if (typeof body === 'string') {
try {
body = JSON.parse(body);
} catch {
return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
}
}
const { name, price, image_url } = body || {};
if (!name || !price || !image_url) {
return res.status(400).json({ ok: false, error: 'name, price and image_url are required' });
}
const caption =
`🛍 Mahsulot nomi: ${name}\n` +
`💰 Narxi: ${price} so'm\n\n` +
`📞 Buyurtma uchun murojaat qiling`;
try {
const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ chat_id: CHANNEL_ID, photo: image_url, caption }),
});
const data = await tgRes.json();
if (!data.ok) {
return res.status(502).json({ ok: false, error: 'Telegram error', details: data });
}
return res.status(200).json({ ok: true, message_id: data.result.message_id });
} catch (err) {
return res.status(500).json({ ok: false, error: String(err) });
}
}
