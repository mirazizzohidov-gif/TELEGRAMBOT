// BITO API yo'llari. Agar BITO hujjatlarida boshqacha bo'lsa, faqat shu ikki qatorni o'zgartiring.
const BITO_PRODUCT_PATH = '/product/get-paging';
const BITO_PRICE_ITEMS_PATH = '/price-items/get-paging';

async function bitoPost(path, payload) {
const { BITO_API_URL, BITO_API_KEY } = process.env;
const r = await fetch(`${BITO_API_URL.replace(/\/$/, '')}${path}`, {
method: 'POST',
headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BITO_API_KEY}` },
body: JSON.stringify(payload),
});
const data = await r.json().catch(() => null);
if (!r.ok || !data) {
throw new Error(`BITO ${path} HTTP ${r.status}`);
}
return data.data ?? data;
}

async function getProductFromBito(sku) {
const { BITO_API_URL, BITO_API_KEY, BITO_PRICE_ID, BITO_FILE_URL } = process.env;
if (!BITO_API_URL || !BITO_API_KEY || !BITO_PRICE_ID) {
throw new Error('Missing BITO environment variables');
}
const products = await bitoPost(BITO_PRODUCT_PATH, { search: sku, page: 1, limit: 20 });
const list = Array.isArray(products) ? products : products.data || [];
const product = list.find((p) => p.sku === sku) || list[0];
if (!product) {
return null;
}
const prices = await bitoPost(BITO_PRICE_ITEMS_PATH, { price_id: BITO_PRICE_ID, search: sku, page: 1, limit: 20 });
const priceList = Array.isArray(prices) ? prices : prices.data || [];
const priceItem = priceList.find((p) => p.product && p.product._id === product._id);
let image = product.image || (product.images && product.images[0]) || '';
if (image && !/^https?:\/\//.test(image)) {
image = `${(BITO_FILE_URL || BITO_API_URL).replace(/\/$/, '')}${image}`;
}
return {
name: product.name,
price: priceItem ? priceItem.amount.toLocaleString('ru-RU').replace(/ /g, ' ') : '',
image_url: image,
};
}

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
let { name, price, image_url, sku } = body || {};
if (sku && (!name || !price || !image_url)) {
try {
const product = await getProductFromBito(String(sku));
if (!product) {
return res.status(404).json({ ok: false, error: 'Product not found in BITO' });
}
name = name || product.name;
price = price || product.price;
image_url = image_url || product.image_url;
} catch (err) {
return res.status(502).json({ ok: false, error: 'BITO error', details: String(err) });
}
}
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
