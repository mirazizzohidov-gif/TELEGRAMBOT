// BITO Integration API: https://docs.bito.uz/guide/api.html
const DEFAULT_API_URL = 'https://api.bito.uz/integration-api/integration/api/v2';
const DEFAULT_FILE_URL = 'https://api.bito.uz/upload-api/public';
const PAGE_SIZE = 50;

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

export const productImage = (p) => p.image || (Array.isArray(p.images) ? p.images.find(Boolean) : '') || '';

// Total stock across organizations.
export const productStock = (p) =>
  (Array.isArray(p.organizations) ? p.organizations : []).reduce((sum, o) => sum + (Number(o.amount) || 0), 0);

export async function getProductsPage(payload) {
  const data = await bitoPost('/product/get-paging', payload);
  return { total: Number(data?.total) || 0, list: listOf(data) };
}

export async function findBySku(sku) {
  const { list } = await getProductsPage({ page: 1, limit: PAGE_SIZE, search: sku });
  return list.find((p) => String(p.sku) === sku) || null;
}

// Newest product (by created_at) that has an image.
export async function findLatest() {
  const { list } = await getProductsPage({ page: 1, limit: PAGE_SIZE, sort: '-created_at' });
  let latest = null;
  for (const p of list) {
    if (!productImage(p)) {
      continue;
    }
    if (!latest || new Date(p.created_at) > new Date(latest.created_at)) {
      latest = p;
    }
  }
  return latest;
}

// Products with created_at >= since (ms), paging newest-first until older ones appear.
export async function findProductsSince(since, maxPages = 20) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const { list } = await getProductsPage({ page, limit: PAGE_SIZE, sort: '-created_at' });
    let older = false;
    for (const p of list) {
      if (Date.parse(p.created_at) >= since) {
        out.push(p);
      } else {
        older = true;
      }
    }
    if (older || list.length < PAGE_SIZE) {
      break;
    }
  }
  return out;
}

export async function findPrice(productId) {
  const { BITO_PRICE_ID } = process.env;
  if (!BITO_PRICE_ID) {
    throw new BitoError(500, 'Missing BITO_PRICE_ID');
  }
  const list = listOf(
    await bitoPost('/price/items/get-paging', { page: 1, limit: PAGE_SIZE, price_id: BITO_PRICE_ID, product_id: productId }),
  );
  const item = list.find((i) => (i.product?._id || i.product_id) === productId);
  return item ? Number(item.amount) : null;
}

// Queue item for a product. price is a number (so'm).
export function toItem(product, amount, type = 'new', extra = {}) {
  return {
    type,
    sku: String(product.sku),
    product_id: product._id,
    name: product.name,
    price: Number(amount),
    image_url: imageUrl(productImage(product)),
    stock: productStock(product),
    created_at: product.created_at,
    ...extra,
  };
}

// body: { latest: true } | { sku } | { name, price, image_url }
export async function resolveProduct(body) {
  let { name, price, image_url, sku, latest } = body || {};
  if (latest === true || (sku && (!name || !price || !image_url))) {
    const product = latest === true ? await findLatest() : await findBySku(String(sku));
    if (!product) {
      throw new BitoError(404, latest === true ? 'No product with image found in BITO' : 'Product not found in BITO');
    }
    if (!price) {
      const amount = await findPrice(product._id);
      if (amount == null) {
        throw new BitoError(404, 'Price not found in BITO', { product_id: product._id });
      }
      price = formatPrice(amount);
    }
    name = name || product.name;
    image_url = image_url || imageUrl(productImage(product));
  }
  if (!name || !price || !image_url) {
    throw new BitoError(400, 'name, price and image_url are required');
  }
  return { name, price: String(price), image_url };
}
