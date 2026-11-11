// "❌ Tugaganlar" on the dashboard: products the stock scanner saw run out (K.stockOut, lib/stock.js), with
// their photos and channel posts — and "🗑 O'chirish": the product goes completely, in two steps:
//   1) sold_prepare {pids}  -> what will be deleted + a one-time token (10 min)
//   2) sold_delete {token, confirm: "OCHIR"} -> for each product: still 0 in BITO? -> BITO soft-delete
//      (restorable in BITO's deleted products) -> its channel posts and "❌ TUGADI" alerts are deleted in
//      Telegram -> every trace in Redis goes (post registry, stock indexes, queues, waitlist, tracking).
// A product that is back in stock, or that BITO refuses to delete, is left untouched.

import { randomBytes } from 'node:crypto';
import { getAllCategories, getProductById, productStock } from './bito.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { WAREHOUSES, whByKey } from './warehouses.js';
import { whMap, whState } from './whstock.js';
import { igImageUrl } from './ig.js';

// small cached copy (/api/igimg kind 'thumb', 320px WebP) instead of the full-size BITO photo
const thumb = (url) => {
  if (!url || !/^https?:\/\//.test(url)) return url || null;
  try {
    return igImageUrl(url, 'thumb');
  } catch {
    return url;
  }
};

const POSTS = () => `${db.K.flag('posts')}:reg`; // lib/postreg.js
const INDEX = () => `${db.K.flag('posts')}:index`;
const EDITS = () => `${db.K.flag('posts')}:edits`;
const TOKEN = (t) => `${db.K.flag('solddel')}:${t}`;
const FORM = () => `${db.K.flag('bito')}:delete_form`;
const LOG = () => `${db.K.flag('solddel')}:log`;
const PENDING = () => `${db.K.flag('solddel')}:pending`; // hash pid -> sku: queues still to clean (lib/tick.js)
export const CONFIRM_WORD = 'OCHIR';

const arr = (v) => (Array.isArray(v) ? v : []);
const r = () => db.redis();

async function hgetallSafe(key) {
  return (await r().hgetall(key)) || {};
}

// ---- list ----

// BITO category tree: leaf -> [main, 2nd level, ..., leaf] names
async function categoryPaths() {
  const raw = await getAllCategories().catch(() => null); // { total, list }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : [];
  const byId = new Map(list.map((c) => [String(c.id), c]));
  const byName = new Map();
  for (const c of list) if (!byName.has(c.name)) byName.set(c.name, c);
  const path = (c) => {
    const out = [];
    for (let x = c, n = 0; x && n < 10; x = x.parent_id ? byId.get(String(x.parent_id)) : null, n++) out.unshift(x.name);
    return out;
  };
  return (id, name) => {
    const c = (id && byId.get(String(id))) || (name && byName.get(name));
    return c ? path(c) : name ? [name] : [];
  };
}

// wh: 'shop' (default) | 'sklad' | 'all'. 'all' = sold out everywhere (K.stockOut, as before);
// 'shop' = 0 in do'kon now (+ everything sold out everywhere); 'sklad' = 0 in do'kon, but the sklad has some.
export async function soldItems(whKey = 'shop') {
  const [out, stock, posts, pathOf, table, wst] = await Promise.all([hgetallSafe(db.K.stockOut), hgetallSafe(db.K.stock), hgetallSafe(POSTS()), categoryPaths(), whMap().catch(() => ({})), whState().catch(() => ({}))]);
  const low = whKey === 'low';
  const w = whKey === 'all' || low ? null : whByKey(whKey) || WAREHOUSES[0];
  const LOW = Number(process.env.WH_LOW_MAX) || 2; // "⚠️ Do'konda kam": 1..LOW in do'kon, some in sklad
  const useTable = Object.keys(table).length > 0;
  // amount of a product in a warehouse: [amount, updated_ms] or null (never there)
  const amt = (pid, wid) => {
    if (useTable) return table[pid]?.[wid] || null;
    const rec = stock[pid];
    return rec?.wh && wid in rec.wh ? [rec.wh[wid], rec.who?.[wid] || null] : null;
  };
  const counts = { all: Object.keys(out).length, low: 0 };
  for (const x of WAREHOUSES) counts[x.key] = 0;
  const pick = new Map(); // pid -> { at, approx, all }
  const pids = new Set([...Object.keys(stock), ...Object.keys(out)]);
  const main = WAREHOUSES.find((x) => x.main);
  for (const pid of pids) {
    const rec = stock[pid];
    const shopA = amt(pid, main.id);
    const shopOut = out[pid] || (rec && (!shopA || shopA[0] <= 0));
    if (rec && shopA && shopA[0] > 0 && shopA[0] <= LOW && WAREHOUSES.some((x) => !x.main && amt(pid, x.id)?.[0] > 0)) {
      counts.low++;
      if (low) pick.set(pid, { at: shopA[1] || null, approx: true, all: false });
    }
    for (const x of WAREHOUSES) {
      // do'kon: 0 in do'kon (or sold out everywhere); another warehouse (sklad): 0 in do'kon but some here
      // — what to bring from that warehouse to the shop
      const a = x.main ? shopA : amt(pid, x.id);
      const hit = x.main ? (rec && shopA && shopA[0] <= 0) || out[pid] : rec && shopOut && a && a[0] > 0;
      if (!hit) continue;
      counts[x.key]++;
      if (w && x.id === w.id) {
        const at = out[pid] ? Number(out[pid]?.at) || Number(rec?.out_at) || shopA?.[1] : shopA?.[1] || Number(rec?.out_at) || null;
        pick.set(pid, { at: at || null, approx: !out[pid] || Boolean(out[pid]?.approx), all: Boolean(out[pid]) });
      }
    }
  }
  if (!w && !low) for (const [pid, o] of Object.entries(out)) pick.set(pid, { at: Number(o?.at) || Number(stock[pid]?.out_at) || null, approx: Boolean(o?.approx), all: true });
  const elseOf = (pid) => WAREHOUSES.filter((x) => !x.main).map((x) => ({ name: x.name, amount: Number(amt(pid, x.id)?.[0]) || 0 })).filter((x) => x.amount > 0);
  const items = [...pick.entries()].map(([pid, o]) => {
    const rec = stock[pid] || {};
    const reg = arr(posts[pid]);
    const last = reg[reg.length - 1]?.item || {};
    const elsewhere = elseOf(pid);
    return {
      pid,
      sku: rec.sku || last.sku || null,
      name: rec.name || last.name || '',
      image: thumb(rec.img || last.image_url || null),
      image_full: rec.img || last.image_url || null,
      ...(() => {
        const leaf = rec.catn || last.category || null;
        const path = pathOf(rec.cat, leaf);
        return { category: path[0] || null, sub: path.length > 2 ? path[1] : null, leaf: path[path.length - 1] || leaf };
      })(),
      out_at: o.at,
      approx: o.approx,
      all_out: Boolean(o.all),
      elsewhere,
      shop: Number(amt(pid, main.id)?.[0]) || 0,
      posts: reg.filter((e) => e && e.chat && e.mid).length,
    };
  });
  items.sort((a, b) => (b.out_at || 0) - (a.out_at || 0));
  return {
    total: items.length,
    wh: low ? 'low' : w ? w.key : 'all',
    collected: wst.last_full_at ? null : { with: wst.seen || 0, total: wst.total || 0, error: wst.error || null },
    warehouses: [...WAREHOUSES.map((x) => ({ key: x.key, name: x.main ? x.name : `${x.name}da bor`, count: counts[x.key] })), { key: 'low', name: "Do'konda kam qoldi", count: counts.low }, { key: 'all', name: 'Ikkalasida ham', count: counts.all }],
    items,
  };
}

// ---- step 1 ----

export async function soldPrepare(pids) {
  const out = await hgetallSafe(db.K.stockOut);
  const list = [...new Set(arr(pids).map(String))].filter((p) => /^[0-9a-f]{24}$/i.test(p) && out[p]).slice(0, 300);
  if (!list.length) return { ok: false, message: "Tanlangan mahsulotlar tugaganlar ro'yxatida yo'q" };
  const posts = await hgetallSafe(POSTS());
  const nPosts = list.reduce((n, p) => n + arr(posts[p]).filter((e) => e?.chat && e?.mid).length, 0);
  const token = randomBytes(12).toString('hex');
  await r().set(TOKEN(token), { pids: list, done: [], at: Date.now() }, { ex: 600 });
  return { ok: true, token, count: list.length, posts: nPosts, confirm: CONFIRM_WORD };
}

// ---- BITO soft-delete (the API form is found once and remembered) ----

async function bitoCall(method, path, body) {
  const { BITO_API_KEY, BITO_API_URL } = process.env;
  if (!BITO_API_KEY) throw new Error('BITO_API_KEY yo\'q');
  const base = String(BITO_API_URL || 'https://api.bito.uz/integration-api/integration/api/v2').replace(/\/+$/, '');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'api-key': BITO_API_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, ok: Boolean(json) && String(json.code) === '0', json, text: text.slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}

const DELETE_FORMS = [
  { name: 'DELETE /product/delete/:id', run: (id) => bitoCall('DELETE', `/product/delete/${id}`) },
  { name: 'POST /product/delete {_id}', run: (id) => bitoCall('POST', '/product/delete', { _id: id }) },
  { name: 'POST /product/delete {id}', run: (id) => bitoCall('POST', '/product/delete', { id }) },
  { name: 'DELETE /product/delete {_id}', run: (id) => bitoCall('DELETE', '/product/delete', { _id: id }) },
  { name: 'POST /product/delete-many {ids}', run: (id) => bitoCall('POST', '/product/delete-many', { ids: [id] }) },
  { name: 'DELETE /product/delete-many {ids}', run: (id) => bitoCall('DELETE', '/product/delete-many', { ids: [id] }) },
];

// the product as BITO has it now (no cache): object; null when BITO says it is not there; undefined when unknown
const NOT_FOUND = /not ?found|topilmadi|mavjud emas|не найден|deleted/i;
async function freshProduct(id) {
  const forms = [
    () => bitoCall('GET', `/product/get-by-id/${id}`),
    () => bitoCall('POST', '/product/get-by-id', { _id: id }),
    () => bitoCall('POST', '/product/get-by-id', { id }),
  ];
  let missing = false;
  for (const f of forms) {
    const a = await f().catch(() => null);
    if (!a) continue;
    if (a.ok) {
      const d = a.json?.data ?? a.json;
      const p = [d, d?.product, ...(Array.isArray(d) ? d : []), ...(Array.isArray(d?.data) ? d.data : [])].find(
        (x) => x && typeof x === 'object' && String(x._id) === String(id),
      );
      if (p) return p;
      missing = true;
    } else if (a.json && NOT_FOUND.test(String(a.json.message || ''))) {
      missing = true;
    }
  }
  if (missing) return null;
  const p = await getProductById(id).catch(() => undefined);
  return p === undefined ? undefined : p || null;
}

const gone = (p) => p === null || Boolean(p?.is_deleted || p?.deleted || p?.deleted_at);

async function bitoDelete(id) {
  const saved = await r().get(FORM()).catch(() => null);
  const forms = [...DELETE_FORMS].sort((a, b) => (b.name === saved) - (a.name === saved));
  const errors = [];
  for (const f of forms) {
    let res;
    try {
      res = await f.run(id);
    } catch (e) {
      errors.push(`${f.name}: ${e.message}`);
      continue;
    }
    if (!res.ok) {
      // a route that exists but refuses (stock booked / in transit ...) is the real answer
      const msg = res.json?.message || res.text;
      if (res.status !== 404 && res.status !== 405 && res.json && !/not found|cannot (post|delete)|no route/i.test(String(msg))) {
        errors.push(`${f.name}: ${msg}`);
        if (f.name === saved) break;
      }
      continue;
    }
    // code "0" from a delete route is the answer; a product still returned unchanged means a wrong form
    const after = await freshProduct(id);
    if (after === undefined || gone(after)) {
      if (f.name !== saved) await r().set(FORM(), f.name).catch(() => {});
      return { ok: true };
    }
    errors.push(`${f.name}: javob ok, lekin mahsulot hali bor`);
  }
  return { ok: false, error: errors.slice(-2).join(' · ') || "BITO o'chirish usuli topilmadi" };
}

// ---- Telegram + Redis cleanup ----

const sameItem = (e, pid, sku) => {
  if (e == null) return false;
  if (typeof e !== 'object') return String(e) === pid || (sku && String(e) === sku);
  const ids = [e.pid, e.product_id, e.id, e._id, e.item?.pid, e.item?._id].filter(Boolean).map(String);
  const skus = [e.sku, e.item?.sku].filter((x) => x != null).map(String);
  return ids.includes(pid) || Boolean(sku && skus.includes(sku));
};

async function filterList(key, pid, sku) {
  const all = (await r().lrange(key, 0, -1)) || [];
  const keep = all.filter((e) => !sameItem(e, pid, sku));
  if (keep.length === all.length) return 0;
  await r().del(key);
  if (keep.length) await r().rpush(key, ...keep);
  return all.length - keep.length;
}

async function deleteMsg(chat, mid) {
  try {
    await tg('deleteMessage', { chat_id: chat, message_id: Number(mid) });
    return true;
  } catch {
    return false;
  }
}

async function wipe(pid, sku) {
  const reg = arr(await r().hget(POSTS(), pid));
  const alerts = arr(await r().hget(db.K.reportPid, pid));
  let deleted = 0;
  let kept = 0;
  for (const e of reg.filter((x) => x?.chat && x?.mid)) (await deleteMsg(e.chat, e.mid)) ? deleted++ : kept++;
  for (const m of alerts.filter((x) => x?.chat && x?.mid)) await deleteMsg(m.chat, m.mid);
  const edits = reg.filter((x) => x?.chat && x?.mid).map((x) => `${x.chat}:${x.mid}`);
  if (edits.length) await r().hdel(EDITS(), ...edits).catch(() => {});
  await r().hdel(POSTS(), pid).catch(() => {});
  await r().hdel(INDEX(), pid).catch(() => {});
  await r().hdel(db.K.reportPid, pid).catch(() => {});
  await r().hdel(db.K.stockOut, pid).catch(() => {});
  await r().hdel(db.K.stockLow, pid).catch(() => {});
  await r().hdel(db.K.stock, pid).catch(() => {});
  await r().hdel(db.K.stockPassSeen, pid).catch(() => {});
  await r().hdel(db.K.waitIndex, pid).catch(() => {});
  await r().del(db.K.wait(pid)).catch(() => {});
  if (sku) {
    await r().hdel(db.K.sent, sku).catch(() => {});
    await r().hdel(db.K.randomHist, sku).catch(() => {});
  }
  // The queues are rewritten only under the tick lock (the tick rewrites them too). Tick busy -> the
  // product waits in PENDING and the tick cleans it first thing (soldCleanup).
  await r().hset(PENDING(), { [pid]: sku || '' });
  if (await db.lock('tick', 120)) {
    try {
      await soldCleanup();
    } finally {
      await db.unlock('tick');
    }
  }
  return { deleted, kept };
}

const QUEUES = () => [db.K.squeue, db.K.queue, db.K.restockQueue, db.K.ch2Queue, db.K.pqueue, db.K.recent].filter(Boolean);

// Removes deleted products from every queue. Only while holding the tick lock.
export async function soldCleanup() {
  const pending = await hgetallSafe(PENDING());
  const pids = Object.keys(pending);
  if (!pids.length) return 0;
  for (const key of QUEUES()) {
    const all = (await r().lrange(key, 0, -1)) || [];
    const keep = all.filter((e) => !pids.some((pid) => sameItem(e, pid, pending[pid] ? String(pending[pid]) : null)));
    if (keep.length !== all.length) {
      await r().del(key);
      if (keep.length) await r().rpush(key, ...keep);
    }
  }
  await r().hdel(PENDING(), ...pids);
  console.log(`solddel: queues cleaned for ${pids.length} product(s)`);
  return pids.length;
}

// ---- step 2 ----

export async function soldDelete(token, confirm) {
  if (String(confirm || '').trim().toUpperCase() !== CONFIRM_WORD) return { ok: false, message: `Tasdiqlash uchun ${CONFIRM_WORD} deb yozing` };
  if (!/^[0-9a-f]{24}$/.test(String(token || ''))) return { ok: false, message: "Tasdiqlash muddati o'tgan — qaytadan bosing" };
  const job = await r().get(TOKEN(token));
  if (!job) return { ok: false, expired: true, message: "Tasdiqlash muddati o'tgan (10 daqiqa) — qaytadan bosing" };
  if (!(await db.lock('solddel', 120))) return { ok: false, busy: true, message: "Boshqa o'chirish ishlayapti — biroz kutib davom etadi" };
  const results = [];
  try {
    const pid = arr(job.pids).find((p) => !arr(job.done).includes(p));
    if (pid) {
      const rec = (await r().hget(db.K.stock, pid)) || {};
      const sku = rec.sku ? String(rec.sku) : null;
      const label = `${rec.name || pid}${sku ? ` (SKU ${sku})` : ''}`;
      job.done.push(pid);
      await r().set(TOKEN(token), job, { ex: 600 });
      const res = await deleteOne(pid, sku, label);
      console.log(`solddel ${pid} ${sku || ''}: ${res.ok ? 'ok' : 'skip'} — ${res.message}`);
      results.push(res);
    }
    const remaining = arr(job.pids).length - job.done.length;
    if (remaining <= 0) await r().del(TOKEN(token));
    const okN = results.filter((x) => x.ok).length;
    if (okN) {
      await r().lpush(LOG(), { at: Date.now(), items: results.filter((x) => x.ok).map((x) => x.label) }).catch(() => {});
      await r().ltrim(LOG(), 0, 99).catch(() => {});
    }
    return { ok: true, results, remaining };
  } finally {
    await db.unlock('solddel');
  }
}

async function deleteOne(pid, sku, label) {
  const p = await freshProduct(pid);
  if (p === undefined) return { pid, ok: false, label, message: "BITO javob bermadi — keyinroq qayta urinib ko'ring" };
  if (p && !gone(p) && productStock(p) > 0) {
    await r().hdel(db.K.stockOut, pid).catch(() => {});
    return { pid, ok: false, label, message: `Qayta kelgan (qoldiq ${productStock(p)}) — o'chirilmadi` };
  }
  if (p && !gone(p)) {
    const b = await bitoDelete(pid);
    if (!b.ok) return { pid, ok: false, label, message: `BITO o'chirmadi: ${b.error}` };
  }
  const w = await wipe(pid, sku);
  return { pid, ok: true, label, message: `✅ O'chirildi: BITO + ${w.deleted} ta post${w.kept ? ` (${w.kept} ta postni Telegram o'chirmadi)` : ''}` };
}
