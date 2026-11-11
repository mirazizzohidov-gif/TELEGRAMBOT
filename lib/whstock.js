// Per-warehouse stock from BITO's product-warehouse table (one row per product × warehouse it ever had:
// amount, updated_at). A product with no row for a warehouse never was there. Read in passes, 200 rows
// a page, a few pages per tick (and while the dashboard's "❌ Tugaganlar" is open); kept in Redis as
// hash `${pid}:${warehouseId}` -> [amount, updated_ms].
import { bitoPost } from './bito.js';
import * as db from './store.js';

const KEY = () => `${db.K.flag('whstock')}:amt`;
const STATE = () => `${db.K.flag('whstock')}:state`;
const PATHK = () => `${db.K.flag('whstock')}:path`;
const LIMIT = 200;
const PATHS = ['/product-warehouse/get-paging', '/product/warehouse/get-paging', '/product_warehouse/get-paging', '/product-warehouses/get-paging', '/warehouse/product/get-paging'];
const r = () => db.redis();

async function page(n) {
  const known = await r().get(PATHK());
  const list = known ? [known] : process.env.BITO_WH_PATH ? [process.env.BITO_WH_PATH] : PATHS;
  let last = null;
  for (const path of list) {
    try {
      const data = await bitoPost(path, { page: n, limit: LIMIT });
      if (!Array.isArray(data?.data)) throw new Error('no data list');
      if (!known) await r().set(PATHK(), path);
      return { rows: data.data, total: Number(data.total) || 0 };
    } catch (e) {
      last = e;
      if (known) await r().del(PATHK()); // the remembered form stopped working: look again next time
    }
  }
  throw new Error(`product-warehouse table not reachable: ${last?.details?.message || last?.message || '?'}`);
}

export const whState = async () => (await r().get(STATE())) || {};

// Continue the current pass while time lasts.
export async function whSync({ deadline = Date.now() + 20000, maxPages = 15 } = {}) {
  if (!(await db.lock('whstock', 120))) return { busy: true, state: await whState() };
  let st = await whState();
  try {
    if (!st.page || (st.done && Date.now() - (st.done_at || 0) > 10 * 60 * 1000)) st = { page: 1, done: false, total: st.total || 0, seen: 0, pass_at: Date.now(), last_full_at: st.last_full_at || null };
    if (st.done) return { state: st };
    for (let i = 0; i < maxPages && Date.now() < deadline - 3000; i++) {
      const { rows, total } = await page(st.page);
      st.total = total || st.total;
      const fields = {};
      for (const x of rows) {
        if (!x?.product_id || !x?.warehouse_id || x.is_deleted) continue;
        fields[`${x.product_id}:${x.warehouse_id}`] = [Number(x.amount) || 0, Date.parse(x.updated_at) || null];
      }
      if (Object.keys(fields).length) await r().hset(KEY(), fields);
      st.seen += rows.length;
      if (rows.length < LIMIT || st.seen >= st.total) {
        st.done = true;
        st.done_at = Date.now();
        st.last_full_at = Date.now();
        st.error = null;
        break;
      }
      st.page++;
    }
    st.error = null;
  } catch (e) {
    st.error = e.message;
    console.error(`whstock: ${e.message}`);
  } finally {
    await r().set(STATE(), st);
    await db.unlock('whstock');
  }
  return { state: st };
}

// pid -> { warehouseId: [amount, updated_ms] }
export async function whMap() {
  const raw = (await r().hgetall(KEY())) || {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const [pid, wid] = k.split(':');
    (out[pid] ||= {})[wid] = Array.isArray(v) ? v : [Number(v) || 0, null];
  }
  return out;
}
