// "📜 BITO jurnali": everything that changes in BITO, as a log — on the dashboard and in one Telegram group,
// each kind of change in its own topic (forum thread):
//   🆕 new products · 🗑 deleted products · 💲 price changes · 🖼 photo changes · ✏️ name / SKU / category
//   📉 write-offs · 📥 purchases · ↩️ returns to suppliers · 📋 inventory counts · 🔁 transfers · 📊 daily summary
//
// Products: the stock scanner (lib/stock.js observeProduct) hands every product it reads to auditProduct,
// which compares it with the last snapshot. Prices: the main price list is walked a few pages per tick.
// Documents (write-offs, purchases, ...): the newest page of each list every tick. BITO's Integration API
// paths for documents are not documented for us: several are tried, the one that works is remembered.
// Nothing is reported for what existed before the journal was switched on (the first look only remembers).

import { bitoGet, bitoPost, formatPrice, imageUrl, productCategory, productImage, productStock } from './bito.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { channel2Owner } from './channel2.js';

const F = (k) => `${db.K.flag('audit')}:${k}`;
const SNAP = () => F('snap'); // hash pid -> { n, s, i, c, cn }
const PRICE = () => F('price'); // hash pid -> amount
const PCUR = () => F('pcur'); // { page, primed }
const LOG = () => F('log'); // list, newest first
const OUT = () => F('out'); // list waiting for Telegram
const TOPICS = () => F('topics'); // hash type -> message_thread_id
const PATHS = () => F('paths'); // hash type -> working path
const STATUS = () => F('status'); // hash type -> { ok, at, error }
const DOCCUR = () => F('doccur'); // hash type -> { at, ids }
const DELSEEN = () => F('delseen'); // hash pid -> 1
const SEEN = () => F('seen'); // hash pid -> catalog pass that last saw it (lib/stock.js)
const SINCE = () => F('since');
const DAY = (d) => F(`day:${d}`); // hash type -> count
const LOG_MAX = 2000;
const PRICE_PAGE = 200;

export const TYPES = [
  { type: 'new', title: '🆕 Yangi mahsulotlar' },
  { type: 'deleted', title: "🗑 O'chirilgan mahsulotlar" },
  { type: 'price', title: "💲 Narx o'zgarishi" },
  { type: 'image', title: "🖼 Rasm o'zgarishi" },
  { type: 'edit', title: '✏️ Nom, SKU, kategoriya' },
  { type: 'writeoff', title: '📉 Hisobdan chiqarish' },
  { type: 'purchase', title: '📥 Kirim (xarid)' },
  { type: 'preturn', title: '↩️ Yetkazuvchiga qaytarish' },
  { type: 'revision', title: '📋 Inventarizatsiya' },
  { type: 'transfer', title: "🔁 Ko'chirish" },
  { type: 'summary', title: '📊 Kunlik xulosa' },
];
const TITLE = Object.fromEntries(TYPES.map((t) => [t.type, t.title]));

const r = () => db.redis();
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const tashDay = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
const hhmm = (ms = Date.now()) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
const who = (d) => d?.responsible_employee?.full_name || d?.responsible?.full_name || d?.created_by_user?.full_name || d?.sender_employee?.full_name || '';
// the device a document was made on (BITO gives it for inventory counts)
const deviceOf = (d) => {
  const v = d?.device;
  if (!v || typeof v !== 'object') return '';
  const name = v.device_name || v.name || v.device_sign || '';
  const os = v.os ? String(v.os).replace(/^ios$/i, 'iOS').replace(/^android$/i, 'Android') : '';
  return name || os ? ` · 📱 ${esc(name)}${os ? `${name ? ' ' : ''}(${esc(os)})` : ''}` : '';
};
const asList = (d) => {
  for (const x of [d?.data?.data, d?.data?.list, d?.data, d?.list, d]) if (Array.isArray(x)) return x;
  return [];
};

export const auditOn = (s) => s.audit !== false;
export const auditTypeOn = (s, type) => !(Array.isArray(s.audit_off) && s.audit_off.includes(type));

let sinceCache = null;
async function since() {
  if (sinceCache) return sinceCache;
  const v = Number(await r().get(SINCE()));
  if (v > 0) sinceCache = v;
  return sinceCache;
}

// ---- events ----

export async function pushEvent(type, html, extra = {}) {
  const at = Date.now();
  const e = { t: type, at, h: html, ...extra };
  await r().lpush(LOG(), e);
  await r().ltrim(LOG(), 0, LOG_MAX - 1);
  const day = DAY(tashDay(at));
  await r().hincrby(day, type, 1);
  await r().expire(day, 60 * 60 * 24 * 40).catch(() => {});
  const s = await settings();
  if (s.audit_group && auditTypeOn(s, type)) await r().rpush(OUT(), e);
  if (e.a) await sendAlert(s, type, html, e.a);
}

// ---- ⚠️ suspicious changes: straight to the owner ----

export const ALERT_DEFAULTS = { on: true, price_drop: 30, writeoff_sum: 200000, writeoff_qty: 10, revision_minus: 5, night_from: '23:00', night_to: '07:00' };
export const alertCfg = (s) => ({ ...ALERT_DEFAULTS, ...(s.audit_alerts || {}) });
const isNight = (cfg, ms) => {
  const t = hhmm(ms);
  return cfg.night_from > cfg.night_to ? t >= cfg.night_from || t < cfg.night_to : t >= cfg.night_from && t < cfg.night_to;
};
let alertsThisRun = 0;
async function sendAlert(s, type, html, reasons) {
  const cfg = alertCfg(s);
  if (!cfg.on || alertsThisRun >= 20) return;
  alertsThisRun++;
  const text = `⚠️ <b>Shubhali o'zgarish</b> — ${esc(reasons.join(', '))}\n\n${esc(TITLE[type] || type)}:\n${html}`;
  await tg('sendMessage', { chat_id: channel2Owner(), text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }).catch((e) => console.error(`audit alert: ${e.message}`));
}

// reasons a document is suspicious (empty = fine)
function docAlerts(type, d, at, cfg) {
  const out = [];
  if (type === 'writeoff') {
    if (num(d.total_cost) >= cfg.writeoff_sum) out.push(`katta summa (${formatPrice(num(d.total_cost))})`);
    if (num(d.total_amount) >= cfg.writeoff_qty) out.push(`ko'p dona (${num(d.total_amount)})`);
  }
  if (type === 'revision') {
    const diff = num(d.total_difference ?? d.difference);
    if (diff <= -cfg.revision_minus) out.push(`kamomad ${diff} dona`);
    const loss = (d.loss_list || []).reduce((a, x) => a + num(x.amount), 0);
    if (loss >= cfg.writeoff_sum) out.push(`zarar ${formatPrice(loss)}`);
  }
  if (at && isNight(cfg, at)) out.push(`ish vaqtidan tashqari (${hhmm(at)})`);
  return out;
}

let setCache = { at: 0, s: null };
async function settings() {
  if (!setCache.s || Date.now() - setCache.at > 30000) setCache = { at: Date.now(), s: await db.getSettings() };
  return setCache.s;
}

const prodLabel = (name, sku) => `<b>${esc(name || '—')}</b>${sku ? ` (SKU ${esc(sku)})` : ''}`;

// ---- products (called by the stock scanner for every product it reads) ----

// The whole snapshot is read once a minute (one call instead of one per product).
let snapCache = { at: 0, map: null };
async function snapOf(pid) {
  if (!snapCache.map || Date.now() - snapCache.at > 60000) snapCache = { at: Date.now(), map: (await r().hgetall(SNAP())) || {} };
  return snapCache.map[pid] || null;
}
async function saveSnap(pid, v) {
  await r().hset(SNAP(), { [pid]: v });
  if (snapCache.map) snapCache.map[pid] = v;
}

// Products seen in the current catalog pass, written in batches.
let seenBuf = {};
export async function flushSeen() {
  const batch = seenBuf;
  seenBuf = {};
  if (Object.keys(batch).length) await r().hset(SEEN(), batch);
}

export async function auditProduct(p, passId = null) {
  const pid = String(p?._id || '');
  if (!/^[0-9a-f]{24}$/i.test(pid) || !(await since())) return;
  if (passId != null) {
    seenBuf[pid] = String(passId);
    if (Object.keys(seenBuf).length >= 200) await flushSeen();
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(p, k);
  const cat = has('category') || has('categories') ? productCategory(p) : undefined;
  const cur = {
    n: has('name') ? String(p.name ?? '') : undefined,
    s: has('sku') ? String(p.sku ?? '') : undefined,
    i: has('image') || has('images') ? productImage(p) || '' : undefined,
    c: cat === undefined ? undefined : String(cat?.id || ''),
    cn: cat === undefined ? undefined : String(cat?.name || ''),
  };
  const old = await snapOf(pid);
  const keep = (k) => (cur[k] === undefined ? old?.[k] : cur[k]);
  const next = { n: keep('n'), s: keep('s'), i: keep('i'), c: keep('c'), cn: keep('cn') };
  if (!old) {
    await saveSnap(pid, next);
    const created = Date.parse(p.created_at);
    if (created && created >= (await since())) {
      await pushEvent(
        'new',
        `${prodLabel(next.n, next.s)}${next.cn ? ` · ${esc(next.cn)}` : ''} · qoldiq ${productStock(p)}${next.i ? ` · <a href="${esc(imageUrl(next.i))}">rasm</a>` : ' · 📷 rasmsiz'}`,
        { pid, sku: next.s },
      );
    }
    return;
  }
  const changes = [];
  if (cur.n !== undefined && old.n !== undefined && cur.n !== old.n) changes.push(`nomi: «${esc(old.n)}» → «${esc(cur.n)}»`);
  if (cur.s !== undefined && old.s !== undefined && cur.s !== old.s) changes.push(`SKU: ${esc(old.s || '—')} → ${esc(cur.s || '—')}`);
  if (cur.c !== undefined && old.c !== undefined && cur.c !== old.c) changes.push(`kategoriya: ${esc(old.cn || '—')} → ${esc(cur.cn || '—')}`);
  if (changes.length) await pushEvent('edit', `${prodLabel(next.n, next.s)}: ${changes.join('; ')}`, { pid, sku: next.s });
  if (cur.i !== undefined && old.i !== undefined && cur.i !== old.i) {
    const what = !old.i ? 'rasm qo\'shildi' : !cur.i ? 'rasm olib tashlandi' : "rasm o'zgardi";
    await pushEvent('image', `${prodLabel(next.n, next.s)}: ${what}${cur.i ? ` · <a href="${esc(imageUrl(cur.i))}">yangi rasm</a>` : ''}`, { pid, sku: next.s });
  }
  if (JSON.stringify(old) !== JSON.stringify(next)) await saveSnap(pid, next);
}

// After a full catalog pass (lib/stock.js pruneIndexes): a product seen in an earlier pass but not in this
// one is gone from BITO -> "🗑 O'chirilgan". Products never seen in a pass are left alone.
export async function auditPassDone(passId) {
  if (!(await since())) return 0;
  await flushSeen();
  const pass = String(passId);
  const seen = (await r().hgetall(SEEN())) || {};
  // values come back JSON-parsed (a number), so compare as strings
  const gone = Object.keys(seen).filter((pid) => String(seen[pid]) !== pass);
  if (!gone.length) return 0;
  const total = Object.keys(seen).length;
  if (gone.length > Math.max(300, total * 0.2)) {
    console.error(`audit: ${gone.length} of ${total} products missing after pass ${pass} — not reported`);
    await r().del(SEEN());
    return 0;
  }
  const done = (await r().hgetall(DELSEEN())) || {};
  const fresh = gone.filter((pid) => !done[pid]);
  const many = fresh.length >= 5; // a mass deletion: one alert for all of them
  for (const pid of fresh) {
    const snap = (await snapOf(pid)) || {};
    await pushEvent('deleted', `${prodLabel(snap.n, snap.s)}${snap.cn ? ` · ${esc(snap.cn)}` : ''} · BITO katalogida endi yo'q`, { pid, sku: snap.s });
  }
  if (many) await sendAlert(await settings(), 'deleted', `${fresh.length} ta mahsulot BITO'dan o'chirilgan (jurnalda ro'yxati bor)`, ['bir vaqtda ko\'p o\'chirish']);
  await r().hset(DELSEEN(), Object.fromEntries(gone.map((pid) => [pid, 1])));
  await r().hdel(SEEN(), ...gone);
  await r().hdel(SNAP(), ...gone);
  if (snapCache.map) for (const pid of gone) delete snapCache.map[pid];
  return gone.length;
}

// ---- prices: the main price list, a few pages per tick ----

async function auditPrices(deadline) {
  const priceId = process.env.BITO_PRICE_ID;
  if (!priceId) return { skipped: 'no BITO_PRICE_ID' };
  const cur = (await r().get(PCUR())) || { page: 1, primed: false };
  const known = (await r().hgetall(PRICE())) || {};
  const snaps = {};
  let pages = 0;
  let changed = 0;
  while (Date.now() < deadline && pages < 10) {
    const data = await bitoPost('/price/items/get-paging', { page: cur.page, limit: PRICE_PAGE, price_id: priceId });
    const list = asList(data);
    pages++;
    for (const it of list) {
      const pid = String(it?.product?._id || it?.product_id || '');
      const amount = num(it?.amount);
      if (!pid || amount <= 0) continue;
      const old = known[pid] == null ? null : num(known[pid]);
      if (old === amount) continue;
      await r().hset(PRICE(), { [pid]: amount });
      if (!cur.primed) continue;
      if (!snaps[pid]) snaps[pid] = (await snapOf(pid)) || {};
      const name = it?.product?.name || snaps[pid].n;
      const sku = it?.product?.sku || snaps[pid].s;
      changed++;
      if (old === null) {
        await pushEvent('price', `${prodLabel(name, sku)}: narx qo'yildi — <b>${formatPrice(amount)}</b>`, { pid, sku });
      } else {
        const pct = old ? Math.round(((amount - old) / old) * 100) : 0;
        const cfg = alertCfg(await settings());
        const a = pct <= -cfg.price_drop ? [`narx ${Math.abs(pct)}% tushdi`] : [];
        await pushEvent('price', `${prodLabel(name, sku)}: ${formatPrice(old)} → <b>${formatPrice(amount)}</b> (${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%)`, { pid, sku, ...(a.length ? { a } : {}) });
      }
    }
    if (list.length < PRICE_PAGE) {
      cur.page = 1;
      cur.primed = true;
      break;
    }
    cur.page++;
  }
  await r().set(PCUR(), cur);
  return { pages, changed, page: cur.page, primed: cur.primed };
}

// ---- documents ----

const sum = (n) => formatPrice(num(n));
const DOCS = [
  {
    type: 'writeoff',
    paths: ['/write-off/get-paging', '/write_off/get-paging', '/writeoff/get-paging', '/write-offs/get-paging'],
    detail: ['/write-off/get-by-id', '/write_off/get-by-id', '/writeoff/get-by-id'],
    line: (d) =>
      `#${esc(d.number)} · ${d.action === 'defect' ? 'Brak' : 'Hisobdan chiqarildi'}${d.reason?.name ? ` · ${esc(d.reason.name)}` : ''}` +
      `${d.source_warehouse?.name ? ` · ${esc(d.source_warehouse.name)}` : ''} · ${num(d.total_amount)} dona${num(d.total_cost) ? ` · ${sum(d.total_cost)}` : ''}`,
  },
  {
    type: 'purchase',
    paths: ['/purchase/get-paging', '/purchases/get-paging'],
    line: (d) =>
      `#${esc(d.number)} · ${esc(d.supplier?.name || 'yetkazuvchi?')} · ${num(d.total_amount)} dona · ${sum(d.total_cost)}${d.state && d.state !== 'done' ? ` · ${esc(d.state)}` : ''}`,
  },
  {
    type: 'preturn',
    paths: ['/purchase-return/get-paging', '/purchase/return/get-paging', '/purchase_return/get-paging', '/purchase/refund/get-paging'],
    line: (d) => `#${esc(d.number)} · ${esc(d.supplier?.name || '')} · ${num(d.total_amount)} dona${num(d.total_cost) ? ` · ${sum(d.total_cost)}` : ''}`,
  },
  {
    type: 'revision',
    paths: ['/revision/get-paging', '/product-revision/get-paging', '/revision/product/get-paging'],
    line: (d) => {
      const diff = num(d.total_difference ?? d.difference);
      const money = [...(d.profit_list || []), ...(d.loss_list || [])].reduce((a, x) => a + num(x.amount), 0);
      return `#${esc(d.number)} · ${esc(d.warehouse?.name || '')} · sanaldi ${num(d.total_counted)}, kutilgan ${num(d.total_expected)}, farq <b>${diff > 0 ? '+' : ''}${diff}</b>${money ? ` · ${sum(money)}` : ''}${d.state && d.state !== 'done' ? ` · ${esc(d.state)}` : ''}`;
    },
  },
  {
    type: 'transfer',
    paths: ['/internal-transfer/get-paging', '/internal_transfer/get-paging', '/transfer/get-paging', '/internal-transfers/get-paging'],
    line: (d) =>
      `#${esc(d.number)} · ${esc(d.sender_warehouse?.name || '?')} → ${esc(d.receiver_warehouse?.name || '?')} · ${num(d.total_amount)} dona${d.reason?.name ? ` · ${esc(d.reason.name)}` : ''} · ${esc(d.state || '')}`,
  },
];

async function setStatus(type, ok, error = null) {
  await r().hset(STATUS(), { [type]: { ok, at: Date.now(), error: error ? String(error).slice(0, 200) : null } }).catch(() => {});
}

// First working path of a list (remembered); null when none works (tried again at most once an hour).
async function listFrom(type, paths, body) {
  const saved = await r().hget(PATHS(), type);
  if (saved) {
    try {
      return asList(await bitoPost(saved, body));
    } catch (e) {
      await r().hdel(PATHS(), type);
      throw e;
    }
  }
  if (!(await db.once(`audit:try:${type}`, 3600))) return null;
  let last = null;
  for (const p of paths) {
    try {
      const list = asList(await bitoPost(p, body));
      await r().hset(PATHS(), { [type]: p });
      return list;
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error("yo'l topilmadi");
}

async function detailOf(doc, paths) {
  for (const p of paths || []) {
    for (const run of [() => bitoGet(`${p}/${doc._id}`), () => bitoPost(p, { _id: doc._id }), () => bitoPost(p, { id: doc._id })]) {
      try {
        const d = await run();
        const x = d?.data && !Array.isArray(d.data) ? d.data : d;
        if (x && String(x._id) === String(doc._id)) return x;
      } catch {}
    }
  }
  return null;
}

async function auditDocs(def, deadline) {
  if (Date.now() > deadline) return;
  let list;
  try {
    list = await listFrom(def.type, def.paths, { page: 1, limit: 30 });
  } catch (e) {
    await setStatus(def.type, false, e?.details?.message || e.message);
    return;
  }
  if (list === null) return;
  await setStatus(def.type, true);
  const at = (d) => Date.parse(d.created_at) || 0;
  const cur = await r().hget(DOCCUR(), def.type);
  const newest = list.reduce((m, d) => Math.max(m, at(d)), 0);
  if (!cur) {
    await r().hset(DOCCUR(), { [def.type]: { at: newest || Date.now(), ids: list.filter((d) => at(d) === newest).map((d) => String(d._id)) } });
    return;
  }
  const fresh = list.filter((d) => at(d) > cur.at || (at(d) === cur.at && !(cur.ids || []).includes(String(d._id)))).sort((a, b) => at(a) - at(b));
  for (const d of fresh) {
    let line = `${def.line(d)} · ${hhmm(at(d))}${who(d) ? ` · 👤 ${esc(who(d))}` : ''}${deviceOf(d)}`;
    if (def.detail && Date.now() < deadline) {
      const full = await detailOf(d, def.detail);
      const items = (full?.products || full?.items || []).slice(0, 10);
      if (items.length) line += '\n' + items.map((x) => `   • ${esc(x.name || x.product?.name || '')} × ${num(x.amount)}`).join('\n');
    }
    const a = docAlerts(def.type, d, at(d), alertCfg(await settings()));
    await pushEvent(def.type, line, { doc: String(d._id), ...(a.length ? { a } : {}) });
  }
  if (fresh.length) {
    const top = Math.max(cur.at, newest);
    await r().hset(DOCCUR(), { [def.type]: { at: top, ids: list.filter((d) => at(d) === top).map((d) => String(d._id)) } });
  }
}

// a filter BITO may ignore: accepted only when every product it returns is marked deleted
async function onlyDeleted(promise) {
  const list = asList(await promise);
  if (!list.length || !list.every((p) => p?.is_deleted === true)) throw new Error("BITO o'chirilganlar ro'yxatini bermadi");
  return list;
}

// deleted products (BITO soft delete)
async function auditDeleted(deadline) {
  if (Date.now() > deadline) return;
  let list = null;
  const saved = await r().hget(PATHS(), 'deleted');
  const forms = [
    { name: 'GET /product/get-deleted', run: () => bitoGet('/product/get-deleted') },
    { name: 'POST /product/get-deleted', run: () => bitoPost('/product/get-deleted', { page: 1, limit: 200 }) },
    { name: 'POST /product/deleted/get-paging', run: () => bitoPost('/product/deleted/get-paging', { page: 1, limit: 200 }) },
    { name: 'POST /product/get-deleted-paging', run: () => bitoPost('/product/get-deleted-paging', { page: 1, limit: 200 }) },
    { name: 'GET /product/deleted', run: () => bitoGet('/product/deleted') },
    { name: 'POST /product/get-paging {is_deleted}', run: () => onlyDeleted(bitoPost('/product/get-paging', { page: 1, limit: 200, is_deleted: true })) },
    { name: 'POST /product/get-paging {deleted}', run: () => onlyDeleted(bitoPost('/product/get-paging', { page: 1, limit: 200, deleted: true })) },
  ].sort((a, b) => (b.name === saved) - (a.name === saved));
  if (!saved && !(await db.once('audit:try:deleted', 3600))) return;
  let err = null;
  for (const f of forms) {
    try {
      list = asList(await f.run());
      if (f.name !== saved) await r().hset(PATHS(), { deleted: f.name });
      break;
    } catch (e) {
      err = e;
      if (f.name === saved) await r().hdel(PATHS(), 'deleted');
    }
  }
  // no such list in this BITO API: deletions are found by the catalog pass instead (auditPassDone)
  if (!list) return setStatus('deleted', true);
  await setStatus('deleted', true);
  const seen = (await r().hgetall(DELSEEN())) || {};
  const first = !Object.keys(seen).length;
  const add = {};
  for (const p of list) {
    const pid = String(p?._id || '');
    if (!pid || seen[pid]) continue;
    add[pid] = 1;
    if (!first) {
      const snap = (await snapOf(pid)) || {};
      await pushEvent('deleted', `${prodLabel(p.name || snap.n, p.sku || snap.s)}${p.category?.name ? ` · ${esc(p.category.name)}` : ''} · ${hhmm(Date.parse(p.updated_at) || Date.now())}`, { pid, sku: p.sku || snap.s });
    }
  }
  if (Object.keys(add).length) await r().hset(DELSEEN(), add);
}

// ---- Telegram ----

// Turning on "Topics" turns a group into a supergroup with a new id: Telegram answers the old id with
// migrate_to_chat_id, and the new id is saved and used from then on.
async function tgGroup(s, method, payload) {
  try {
    return await tg(method, { ...payload, chat_id: s.audit_group });
  } catch (e) {
    const to = e?.data?.parameters?.migrate_to_chat_id;
    if (!to) throw e;
    s.audit_group = String(to);
    await db.updateSettings({ audit_group: String(to) });
    setCache = { at: 0, s: null };
    return tg(method, { ...payload, chat_id: s.audit_group });
  }
}

async function topicOf(s, type, fresh = false) {
  if (s.audit_notopics) return null; // a group without "Topics": everything in one stream
  if (!fresh) {
    const id = await r().hget(TOPICS(), type);
    if (id) return Number(id);
  }
  const t = await tgGroup(s, 'createForumTopic', { name: TITLE[type] || type });
  await r().hset(TOPICS(), { [type]: t.message_thread_id });
  return Number(t.message_thread_id);
}

async function sendTo(s, type, text) {
  const send = async (thread) =>
    tgGroup(s, 'sendMessage', { ...(thread ? { message_thread_id: thread } : {}), text, parse_mode: 'HTML', disable_web_page_preview: true });
  try {
    return await send(await topicOf(s, type));
  } catch (e) {
    if (/thread not found|TOPIC_DELETED|TOPIC_CLOSED|message thread/i.test(e.message)) return send(await topicOf(s, type, true));
    throw e;
  }
}

export async function ensureTopics(s) {
  const out = [];
  for (const t of TYPES) {
    if (!auditTypeOn(s, t.type)) continue;
    out.push(await topicOf(s, t.type));
  }
  return out.length;
}

async function flush(s, deadline) {
  if (!s.audit_group) return 0;
  const items = (await r().lpop(OUT(), 300)) || [];
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) return 0;
  const by = new Map();
  for (const e of list) {
    if (!e?.t || !auditTypeOn(s, e.t)) continue;
    if (!by.has(e.t)) by.set(e.t, []);
    by.get(e.t).push(e);
  }
  let sent = 0;
  const left = [];
  for (const [type, evs] of by) {
    if (Date.now() > deadline) {
      left.push(...evs);
      continue;
    }
    const head = `<b>${esc(TITLE[type] || type)}</b>${evs.length > 1 ? ` — ${evs.length} ta` : ''}`;
    let chunk = head;
    const parts = [];
    for (const e of evs) {
      const line = `\n• ${e.h}`;
      if (chunk.length + line.length > 3800) {
        parts.push(chunk);
        chunk = head + ' (davomi)';
      }
      chunk += line;
    }
    parts.push(chunk);
    try {
      for (const p of parts) await sendTo(s, type, p);
      sent += evs.length;
      await setStatus('telegram', true);
    } catch (e) {
      await setStatus('telegram', false, e.message);
      if (/rights|not enough|forum|chat not found|kicked|CHAT_ADMIN_REQUIRED/i.test(e.message)) break; // the group needs fixing
      left.push(...evs);
    }
  }
  if (left.length) await r().lpush(OUT(), ...left.reverse());
  await r().ltrim(OUT(), 0, 999);
  return sent;
}

async function dailySummary(s, now = Date.now()) {
  const t = hhmm(now);
  let day;
  if (t >= '23:55') day = tashDay(now);
  else if (t < '06:00') day = tashDay(now - 86400000);
  else return;
  if (!s.audit_group || !auditTypeOn(s, 'summary')) return;
  if (!(await db.once(`audit:sum:${day}`, 60 * 60 * 24 * 3))) return;
  const c = (await r().hgetall(DAY(day))) || {};
  const lines = TYPES.filter((x) => x.type !== 'summary').map((x) => `${x.title}: <b>${num(c[x.type])}</b>`);
  try {
    await sendTo(s, 'summary', `<b>📊 BITO jurnali — ${day.split('-').reverse().join('.')}</b>\n\n${lines.join('\n')}`);
  } catch (e) {
    await db.clearFlag(`audit:sum:${day}`);
    throw e;
  }
}

// ---- the 15-minute job ----

export async function auditTick(s, { deadline = Date.now() + 25000 } = {}) {
  alertsThisRun = 0;
  if (!auditOn(s)) return { skipped: 'off' };
  if (!(await r().get(SINCE()))) {
    await r().set(SINCE(), Date.now());
    sinceCache = null;
  }
  const out = {};
  out.prices = await auditPrices(Math.min(deadline, Date.now() + 12000)).catch((e) => ({ error: e.message }));
  if (out.prices?.error) await setStatus('price', false, out.prices.error);
  else await setStatus('price', true);
  for (const d of DOCS) await auditDocs(d, deadline).catch((e) => setStatus(d.type, false, e.message));
  await auditDeleted(deadline).catch((e) => setStatus('deleted', false, e.message));
  out.sent = await flush(s, deadline + 15000).catch((e) => ({ error: e.message }));
  await dailySummary(s).catch((e) => console.error(`audit summary: ${e.message}`));
  return out;
}

// ---- dashboard ----

export async function auditView() {
  const s = await db.getSettings();
  const [log, status, topics, groups, today] = await Promise.all([
    r().lrange(LOG(), 0, 799),
    r().hgetall(STATUS()),
    r().hgetall(TOPICS()),
    db.listGroups().catch(() => []),
    r().hgetall(DAY(tashDay())),
  ]);
  const g = groups.find((x) => String(x.id) === String(s.audit_group));
  return {
    on: auditOn(s),
    since: Number(await r().get(SINCE())) || null,
    group: s.audit_group ? { id: String(s.audit_group), title: g?.title || s.audit_group_title || String(s.audit_group) } : null,
    groups: groups.filter((x) => String(x.id).startsWith('-')).map((x) => ({ id: String(x.id), title: x.title || String(x.id) })),
    telegram: status?.telegram || null,
    types: TYPES.map((t) => ({ ...t, on: auditTypeOn(s, t.type), topic: Boolean(topics?.[t.type]), today: num(today?.[t.type]), status: status?.[t.type] || null })),
    events: (log || []).filter((e) => e && e.t),
    pending: Number(await r().llen(OUT())) || 0,
    alerts: alertCfg(s),
  };
}

export async function auditSetGroup(id) {
  const groups = await db.listGroups().catch(() => []);
  if (id && !groups.some((g) => String(g.id) === String(id))) return { ok: false, message: "Bu guruh botda yo'q — avval botni guruhga qo'shing" };
  await r().del(TOPICS());
  const title = groups.find((g) => String(g.id) === String(id))?.title || null;
  await db.updateSettings({ audit_group: id ? String(id) : null, audit_group_title: title });
  setCache = { at: 0, s: null };
  if (!id) return { ok: true, message: 'Guruh uzildi' };
  const s = await db.getSettings();
  const why = (e) => e?.data?.description || e?.message || '';
  // getChat: is "Topics" on? (also follows the group -> supergroup move)
  let chat = null;
  try {
    chat = await tgGroup(s, 'getChat', {});
  } catch (e) {
    return { ok: false, message: `Guruhga ulanib bo'lmadi: ${why(e)} — botni guruhga qayta qo'shib, admin qiling` };
  }
  if (!chat?.is_forum) {
    await db.updateSettings({ audit_notopics: true });
    setCache = { at: 0, s: null };
    s.audit_notopics = true;
    try {
      await sendTo(s, 'summary', "✅ <b>BITO jurnali ulandi.</b>\nGuruhda «Mavzular» yoqilmagan — barcha o'zgarishlar shu yerga ketma-ket keladi. Mavzular yoqilsa, dashboard'da «Qayta ulash» ni bosing.");
    } catch (e) {
      return { ok: false, message: `Xabar yuborib bo'lmadi: ${why(e)}` };
    }
    return { ok: true, message: "✅ Ulandi, lekin guruhda «Mavzular» yoqilmagan: xabarlar bitta oqimda keladi. Guruh sozlamalari → «Mavzular» ni yoqib, «Qayta ulash» ni bosing." };
  }
  await db.updateSettings({ audit_notopics: false });
  setCache = { at: 0, s: null };
  s.audit_notopics = false;
  try {
    const n = await ensureTopics(s);
    await sendTo(s, 'summary', "✅ <b>BITO jurnali ulandi.</b>\nHar bir o'zgarish turi o'z mavzusiga keladi. Har kuni 00:00 da shu yerga kunlik xulosa yuboriladi.");
    return { ok: true, message: `✅ Ulandi: ${n} ta mavzu ochildi` };
  } catch (e) {
    const m = why(e);
    const hint = /rights|admin|not enough|manage/i.test(m) ? "Botga guruhda «Mavzularni boshqarish» huquqini bering" : m;
    return { ok: false, message: `Mavzu ochib bo'lmadi: ${hint}` };
  }
}

export async function auditSetAlerts(cfg = {}) {
  const n = (v, min, max, d) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : d);
  const hm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : d);
  const D = ALERT_DEFAULTS;
  const next = {
    on: cfg.on !== false,
    price_drop: n(cfg.price_drop, 1, 99, D.price_drop),
    writeoff_sum: n(cfg.writeoff_sum, 0, 1e9, D.writeoff_sum),
    writeoff_qty: n(cfg.writeoff_qty, 1, 100000, D.writeoff_qty),
    revision_minus: n(cfg.revision_minus, 1, 100000, D.revision_minus),
    night_from: hm(cfg.night_from, D.night_from),
    night_to: hm(cfg.night_to, D.night_to),
  };
  await db.updateSettings({ audit_alerts: next });
  setCache = { at: 0, s: null };
  return { ok: true, message: next.on ? '✅ Signal sozlamalari saqlandi' : '⏸ Signallar o\'chirildi', alerts: next };
}

export async function auditToggle(type, on) {
  if (!TITLE[type]) return { ok: false, message: "Noma'lum tur" };
  const s = await db.getSettings();
  const off = new Set(Array.isArray(s.audit_off) ? s.audit_off : []);
  on ? off.delete(type) : off.add(type);
  await db.updateSettings({ audit_off: [...off] });
  setCache = { at: 0, s: null };
  return { ok: true };
}

export async function auditTest() {
  const s = await db.getSettings();
  if (!s.audit_group) return { ok: false, message: 'Avval guruhni ulang' };
  try {
    await sendTo(s, 'summary', `🧪 Sinov xabari — ${hhmm()}. Jurnal ishlayapti.`);
    return { ok: true, message: '✅ Sinov xabari yuborildi' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
