// BITO Integration API: https://docs.bito.uz/guide/api.html
const DEFAULT_API_URL = 'https://api.bito.uz/integration-api/integration/api/v2';
const DEFAULT_FILE_URL = 'https://api.bito.uz/upload-api/public';

export class BitoError extends Error {
constructor(status, message, details) {
super(message);
this.status = status;
this.details = details;
}
}

const trimSlash = (s) => s.replace(/\/+$/, '');

async function bitoPost(path, payload) {
const { BITO_API_KEY, BITO_API_URL } = process.env;
if (!BITO_API_KEY) {
throw new BitoError(500, 'Missing BITO_API_KEY');
}
const r = await fetch(`${trimSlash(BITO_API_URL || DEFAULT_API_URL)}${path}`, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'api-key': BITO_API_KEY },
body: JSON.stringify(payload),
});
const json = await r.json().catch(() => null);
if (!json || String(json.code) !== '0') {
throw new BitoError(502, 'BITO error', { path, http_status: r.status, code: json?.code, message: json?.message });
}
return json.data;
}

const listOf = (data) => (Array.isArray(data?.data) ? data.data : []);

export function formatPrice(amount) {
return String(Math.round(Number(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function imageUrl(image) {
if (!image) {
return '';
}
if (/^https?:\/\//.test(image)) {
return image;
}
return `${trimSlash(process.env.BITO_FILE_URL || DEFAULT_FILE_URL)}${image.startsWith('/') ? '' : '/'}${image}`;
}

async function findBySku(sku) {
const list = listOf(await bitoPost('/product/get-paging', { page: 1, limit: 50, search: sku }));
return list.find((p) => String(p.sku) === sku) || null;
}

async function findLatest() {
const list = listOf(await bitoPost('/product/get-paging', { page: 1, limit: 50, sort: '-created_at' }));
let latest = null;
for (const p of list) {
if (!latest || new Date(p.created_at) > new Date(latest.created_at)) {
latest = p;
}
}
return latest;
}

async function findPrice(productId) {
const { BITO_PRICE_ID } = process.env;
if (!BITO_PRICE_ID) {
throw new BitoError(500, 'Missing BITO_PRICE_ID');
}
const list = listOf(await bitoPost('/price/items/get-paging', { page: 1, limit: 50, price_id: BITO_PRICE_ID, product_id: productId }));
const item = list.find((i) => (i.product?._id || i.product_id) === productId);
return item ? item.amount : null;
}

// body: { latest: true } | { sku } | { name, price, image_url }
export async function resolveProduct(body) {
let { name, price, image_url, sku, latest } = body || {};
if (latest === true || (sku && (!name || !price || !image_url))) {
const product = latest === true ? await findLatest() : await findBySku(String(sku));
if (!product) {
throw new BitoError(404, 'Product not found in BITO');
}
if (!price) {
const amount = await findPrice(product._id);
if (amount == null) {
throw new BitoError(404, 'Price not found in BITO', { product_id: product._id });
}
price = formatPrice(amount);
}
name = name || product.name;
image_url = image_url || imageUrl(product.image || product.images?.[0]);
}
if (!name || !price || !image_url) {
throw new BitoError(400, 'name, price and image_url are required');
}
return { name, price: String(price), image_url };
}
