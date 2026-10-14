// BITO Integration API: https://docs.bito.uz/guide/api.html
import { bestDiscount } from './discount.js';
import { cached } from './store.js';
import { clock, fetchWithTimeout } from './util.js';

const DEFAULT_API_URL = 'https://api.bito.uz/integration-api/integration/api/v2';
const DEFAULT_FILE_URL = 'https://api.bito.uz/upload-api/public';
// Smaller pages answer faster on BITO; SKU search needs only a few rows.
const PAGE_SIZE = 30;
const SEARCH_SIZE = 20;
// Product / price lookups are cached in Redis (seconds; BITO_CACHE_TTL=0 turns the cache off).
const cacheTtl = () => {
  const v = Number(process.env.BITO_CACHE_TTL);
  return process.env.BITO_CACHE_TTL !== undefined && process.env.BITO_CACHE_TTL !== '' && Number.isFinite(v) ? v : 10 * 60;
};
// BITO can be slow but does answer: wait up to BITO_TIMEOUT_MS (default 60 s), retry once after 2 s on a
// timeout or a 5xx answer.
const bitoTimeoutMs = () => Number(process.env.BITO_TIMEOUT_MS) || 60000;
const RETRY_DELAY_MS = 2000;

export class BitoError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const trimSlash = (s) => s.replace(/\/+$/, '');

// One BITO call (POST with a JSON body, or GET). Logs time and, on failure, BITO's own answer.
async function bitoRequest(method, path, payload, attempt = 1) {
  const { BITO_API_KEY, BITO_API_URL } = process.env;
  if (!BITO_API_KEY) {
    throw new BitoError(500, 'Missing BITO_API_KEY');
  }
  const label = `BITO ${method === 'GET' ? 'GET ' : ''}${path}`;
  const started = Date.now();
  const retry = async (why) => {
    if (attempt >= 2) {
      return null;
    }
    console.log(`${label} ${why} — retrying in ${RETRY_DELAY_MS} ms`);
    await clock.sleep(RETRY_DELAY_MS);
    return bitoRequest(method, path, payload, attempt + 1);
  };
  let r;
  try {
    r = await fetchWithTimeout(
      `${trimSlash(BITO_API_URL || DEFAULT_API_URL)}${path}`,
      method === 'GET'
        ? { method: 'GET', headers: { 'api-key': BITO_API_KEY } }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': BITO_API_KEY },
            body: JSON.stringify(payload),
          },
      bitoTimeoutMs(),
    );
  } catch (e) {
    console.log(`${label} failed after ${Date.now() - started} ms (attempt ${attempt}): ${e.message}`);
    const again = e.code === 'ETIMEDOUT' ? await retry('timed out') : null;
    if (again !== null) return again;
    throw new BitoError(502, 'BITO error', { path, method, message: e.message, attempts: attempt });
  }
  const text = await r.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const payloadText = method === 'GET' ? '' : ` ${JSON.stringify(payload)}`;
  console.log(`${label}${payloadText} -> ${r.status} in ${Date.now() - started} ms (attempt ${attempt})`);
  if (r.status >= 500) {
    const again = await retry(`answered ${r.status}`);
    if (again !== null) return again;
  }
  if (!json || String(json.code) !== '0') {
    const details = {
      path,
      method,
      http_status: r.status,
      code: json?.code,
      message: json?.message ?? (json ? undefined : text.slice(0, 300)),
      attempts: attempt,
    };
    console.log(`${label} error answer: ${JSON.stringify(details)}`);
    throw new BitoError(502, 'BITO error', details);
  }
  return json.data;
}

const bitoPost = (path, payload) => bitoRequest('POST', path, payload);

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

// Stable key of the product's BITO discounts (discount_ids), or null if none.
export const productDiscountKey = (p) =>
  Array.isArray(p.discount_ids) && p.discount_ids.length ? [...p.discount_ids].map(String).sort().join(',') : null;

export async function getProductsPage(payload) {
  const data = await bitoPost('/product/get-paging', payload);
  return { total: Number(data?.total) || 0, list: listOf(data) };
}

// Cached 10 min (admin previews, discount checks). Not-found is not cached.
export async function findBySku(sku, { fresh = false } = {}) {
  const load = async () => {
    const { list } = await getProductsPage({ page: 1, limit: SEARCH_SIZE, search: sku });
    return list.find((p) => String(p.sku) === sku) || null;
  };
  return fresh ? load() : cached(`sku:${sku}`, cacheTtl(), load);
}

// Total number of products (cached) — random picks choose a page from it.
export const productTotal = () =>
  cached('total', cacheTtl(), async () => (await getProductsPage({ page: 1, limit: 1 })).total);

// One catalog page (cached) for random picks.
export const productPage = (page) =>
  cached(`page:${page}`, cacheTtl(), async () => (await getProductsPage({ page, limit: PAGE_SIZE })).list);

export const CATALOG_PAGE_SIZE = PAGE_SIZE;

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

// Price from the price list. A positive price is cached 10 min; "no price" is not cached, so a
// price entered later in BITO is picked up on the next check.
export async function findPrice(productId) {
  const { BITO_PRICE_ID } = process.env;
  if (!BITO_PRICE_ID) {
    throw new BitoError(500, 'Missing BITO_PRICE_ID');
  }
  return cached(
    `price:${BITO_PRICE_ID}:${productId}`,
    cacheTtl(),
    async () => {
      const list = listOf(
        await bitoPost('/price/items/get-paging', { page: 1, limit: PAGE_SIZE, price_id: BITO_PRICE_ID, product_id: productId }),
      );
      const item = list.find((i) => (i.product?._id || i.product_id) === productId);
      return item ? Number(item.amount) : null;
    },
    { keep: (v) => v > 0 },
  );
}

// ---- one product by _id ----
// The Integration API form is not documented for us, so several forms are tried; the first one that
// returns this very product (_id checked) is remembered for the next calls. Errors carry BITO's answers.

const asList = (data) =>
  [data, data?.data, data?.product, data?.result, ...(Array.isArray(data) ? data : []), ...(Array.isArray(data?.data) ? data.data : [])].filter(
    (x) => x && typeof x === 'object' && !Array.isArray(x),
  );

const BY_ID_FORMS = [
  { name: 'GET /product/get-by-id/:id', run: (id) => bitoRequest('GET', `/product/get-by-id/${encodeURIComponent(id)}`) },
  { name: 'POST /product/get-by-id {_id}', run: (id) => bitoPost('/product/get-by-id', { _id: id }) },
  { name: 'POST /product/get-by-id {id}', run: (id) => bitoPost('/product/get-by-id', { id }) },
  { name: 'POST /product/get-paging {ids}', run: (id) => bitoPost('/product/get-paging', { page: 1, limit: 5, ids: [id] }) },
  { name: 'POST /product/get-paging {_ids}', run: (id) => bitoPost('/product/get-paging', { page: 1, limit: 5, _ids: [id] }) },
];

let byIdForm = null; // index of the form that worked (per warm instance)

function byIdOrder() {
  const forms = [...BY_ID_FORMS];
  if (process.env.BITO_PRODUCT_BY_ID_PATH) {
    const path = process.env.BITO_PRODUCT_BY_ID_PATH;
    forms.unshift({ name: `POST ${path} {id}`, run: (id) => bitoPost(path, { id }) });
  }
  if (byIdForm !== null && forms[byIdForm]) {
    forms.unshift(forms.splice(byIdForm, 1)[0]);
  }
  return forms;
}

export async function getProductById(id) {
  return cached(`pid:${id}`, cacheTtl(), async () => {
    const tried = [];
    const forms = byIdOrder();
    for (const form of forms) {
      try {
        const p = asList(await form.run(id)).find((x) => String(x._id) === String(id));
        if (p) {
          byIdForm = BY_ID_FORMS.findIndex((f) => f.name === form.name);
          if (byIdForm < 0) byIdForm = null;
          if (tried.length) console.log(`BITO product by id: "${form.name}" works`);
          return p;
        }
        tried.push(`${form.name}: answer has no product ${id}`);
      } catch (e) {
        tried.push(`${form.name}: ${JSON.stringify(e.details || e.message)}`);
      }
    }
    console.error(`BITO product ${id} could not be loaded. Tried:\n  ${tried.join('\n  ')}`);
    throw new BitoError(502, `Product ${id} could not be loaded`, { id, tried });
  });
}

// ---- discounts ----

const DISCOUNT_PATH = () => process.env.BITO_DISCOUNT_PATH || '/discount/get-all';

const discountList = (data) => (Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : []);

// All discount rules (cached 10 min). If the endpoint fails, posting goes on without discounts.
export async function loadDiscounts() {
  try {
    return await cached('discounts', cacheTtl(), async () => {
      try {
        return discountList(await bitoPost(DISCOUNT_PATH(), {}));
      } catch (e) {
        if (process.env.BITO_DISCOUNT_PATH) throw e;
        // Fallback when get-all is not available.
        return discountList(await bitoPost('/discount/get-paging', { page: 1, limit: 200 }));
      }
    });
  } catch (e) {
    console.error('BITO discounts could not be loaded, prices shown without discounts:', e.message, e.details || '');
    return [];
  }
}

// Price customers pay: { price, old_price } — old_price is set when a BITO discount lowers the price.
export async function priceFor(product, discounts) {
  const amount = await findPrice(product._id);
  if (!(amount > 0)) {
    return { price: amount, old_price: null };
  }
  const best = bestDiscount(amount, product, discounts ?? (await loadDiscounts()));
  return best ? { price: best.price, old_price: amount, discount: best.discount.name } : { price: amount, old_price: null };
}

// Queue item for a product. price is a number (so'm).
// `amount` is a number or a priceFor() result ({ price, old_price }).
export function toItem(product, amount, type = 'new', extra = {}) {
  const pr = typeof amount === 'object' && amount !== null ? amount : { price: amount, old_price: null };
  return {
    type,
    sku: String(product.sku),
    product_id: product._id,
    name: product.name,
    price: Number(pr.price),
    ...(pr.old_price > pr.price ? { old_price: Number(pr.old_price) } : {}),
    image_url: imageUrl(productImage(product)),
    stock: productStock(product),
    created_at: product.created_at,
    discount_ids_key: productDiscountKey(product),
    ...extra,
  };
}

// body: { latest: true } | { sku } | { name, price, image_url }
// Returns { name, price, image_url } (+ discount: { price, old_price } numbers when a BITO discount applies).
export async function resolveProduct(body) {
  let { name, price, image_url, sku, latest } = body || {};
  let discount = null;
  if (latest === true || (sku && (!name || !price || !image_url))) {
    const product = latest === true ? await findLatest() : await findBySku(String(sku));
    if (!product) {
      throw new BitoError(404, latest === true ? 'No product with image found in BITO' : 'Product not found in BITO');
    }
    if (!price) {
      const pr = await priceFor(product);
      if (pr.price == null) {
        throw new BitoError(404, 'Price not found in BITO', { product_id: product._id });
      }
      price = formatPrice(pr.price);
      if (pr.old_price) {
        discount = { price: pr.price, old_price: pr.old_price };
      }
    }
    name = name || product.name;
    image_url = image_url || imageUrl(productImage(product));
  }
  if (!name || !price || !image_url) {
    throw new BitoError(400, 'name, price and image_url are required');
  }
  return { name, price: String(price), image_url, ...(discount ? { discount } : {}) };
}
