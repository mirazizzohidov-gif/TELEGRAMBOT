export default async function handler(req, res) {
if (req.method !== 'POST') {
return res.status(405).json({ ok: false, error: 'Use POST' });
}
const { BOT_TOKEN, CHANNEL_ID, IMAGE_URL, SECRET, PRODUCT_NAME, PRODUCT_PRICE } = process.env;
if (!BOT_TOKEN || !CHANNEL_ID || !IMAGE_URL || !SECRET || !PRODUCT_NAME || !PRODUCT_PRICE) {
return res.status(500).json({ ok: false, error: 'Missing environment variables' });
}
if (req.headers['x-secret'] !== SECRET) {
return res.status(401).json({ ok: false, error: 'Unauthorized' });
}
const caption =
`🛍 Mahsulot nomi: ${PRODUCT_NAME}\n` +
`💰 Narxi: ${PRODUCT_PRICE} so'm\n\n` +
`📞 Buyurtma uchun murojaat qiling`;
try {
const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ chat_id: CHANNEL_ID, photo: IMAGE_URL, caption }),
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
