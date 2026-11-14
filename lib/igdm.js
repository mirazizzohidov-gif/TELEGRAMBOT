// "💬 Avto-javob": Instagram Direct and comments answered by the bot with the product's photo and price.
//   Direct  — a shared post / Reel, a reply to a story, a photo or a product name -> photo + price + stock
//   Izohlar — "narxi?" under a post -> a short public reply + the price in a private message
// Polling (no Meta app review needed): GET conversations / comments of the connected accounts.
// /api/igdm keeps a ~1-minute loop going (kicked by the tick), like the BITO order loop.
// A person from the shop writing in a chat pauses the bot there (human_pause_min).
import { findByName, findByPhoto } from './photosearch.js';
import { formatPrice, getProductById, imageUrl, loadDiscounts, priceFor, productImage, productStock } from './bito.js';
import { igCall, SLOTS, tokenOf } from './ig.js';
import * as db from './store.js';
import { downloadImage } from './story.js';
import { errText } from './util.js';
import { shopUrl } from './waitlist.js';

const F = (x) => db.K.flag(`igdm:${x}`);
const CUR = (slot) => F(`cur:${slot}`); // ms: messages / comments older than this are history
const BOT = (slot) => F(`bot:${slot}`); // hash message id -> 1 (sent by the bot, not by a person)
const LOG = () => F('log'); // list of the latest actions (dashboard)
const ST = () => F('st'); // hash slot -> { ok_at, error, error_at, dm_ok, cm_ok }
const LOOP = 'igdm-loop';
export const DM_DEFAULTS = {
  on: false,
  slots: ['a'],
  dm: true,
  comments: true,
  keywords: "narx, нарх, qancha, qancha turadi, necha pul, nechi pul, nech pul, цена, сколько, почем, стоимость, price, cost, narxi",
  public_reply: "Narxi va ma'lumotni Direct'ga yubordik 📩",
  greet: "Assalomu alaykum! 😊 Qaysi mahsulot qiziqtirdi? Rasmini, nomini yoki postni yuboring — narxini darrov aytaman.",
  not_found: "Afsuski, bu mahsulotni topa olmadim 🙈 Boshqa rasm yoki nomini yuboring, yoki operatorimiz tez orada javob beradi.",
  human_pause_min: 60,
};
export const dmCfg = (s) => ({ ...DM_DEFAULTS, ...(s?.igdm || {}) });
const r = () => db.redis();
const kw = (cfg) => String(cfg.keywords || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const wantsPrice = (text, cfg) => {
  const t = String(text || '').toLowerCase();
  return kw(cfg).some((k) => t.includes(k)) || /^\s*\?+\s*$/.test(t) || /\+\s*$/.test(t);
};

async function log(entry) {
  await r().lpush(LOG(), { at: Date.now(), ...entry }).catch(() => {});
  await r().ltrim(LOG(), 0, 49).catch(() => {});
}

// ---- product -> message ----

async function productCard(pid, s, discounts) {
  const p = await getProductById(pid).catch(() => null);
  if (!p) return null;
  return cardOf(p, s, discounts);
}
async function cardOf(p, s, discounts) {
  const pr = await priceFor(p, discounts).catch(() => ({ price: 0 }));
  const stock = productStock(p);
  const price = pr.price > 0 ? (pr.old_price > pr.price ? `💰 Narxi: ${formatPrice(pr.old_price)} → ${formatPrice(pr.price)} so'm 🔥` : `💰 Narxi: ${formatPrice(pr.price)} so'm`) : '💰 Narxini operator aytadi';
  const text = [`🛍 ${p.name}`, price, stock > 0 ? '✅ Sotuvda bor' : '❌ Hozircha tugagan — kelishi bilan xabar beramiz', s.phone ? `📞 ${s.phone}` : '', `🛒 Buyurtma: shu yerga yozing yoki ${shopUrl(s)}`].filter(Boolean).join('\n');
  const img = productImage(p) ? imageUrl(productImage(p)) : '';
  return { pid: String(p._id), name: p.name, text: text.slice(0, 1000), image: img };
}

// which product is this Instagram post about: the bot's own record, otherwise the caption's "🛍" line
async function productOfMedia(mediaId, t, s) {
  if (!mediaId) return null;
  const rec = await r().get(db.K.flag(`igm:${mediaId}`)).catch(() => null);
  if (rec?.items?.[0]?.pid) return { pid: rec.items[0].pid };
  const m = await igCall('GET', `/${mediaId}`, { fields: 'caption', access_token: t.token }).catch(() => null);
  const line = String(m?.caption || '').split('\n').find((l) => /🛍/.test(l));
  const name = line?.replace(/🛍/g, '').trim();
  if (!name) return null;
  const f = await findByName(name, { limit: 1 }).catch(() => ({ results: [] }));
  return f.results[0] ? { p: f.results[0] } : null;
}

// ---- sending ----

async function send(slot, t, recipient, message) {
  const res = await igCall('POST', `/${t.user_id}/messages`, { recipient: JSON.stringify(recipient), message: JSON.stringify(message), access_token: t.token }, 30000);
  if (res?.message_id) await r().hset(BOT(slot), { [res.message_id]: Date.now() }).catch(() => {});
  return res;
}
async function sendCard(slot, t, igsid, card) {
  if (card.image) await send(slot, t, { id: igsid }, { attachment: { type: 'image', payload: { url: card.image } } }).catch((e) => console.error(`igdm image: ${errText(e)}`));
  return send(slot, t, { id: igsid }, { text: card.text });
}

// ---- Direct ----

async function messagesOf(convId, t) {
  const fields = 'id,created_time,from,message,attachments,story,shares,reply_to';
  try {
    const c = await igCall('GET', `/${convId}`, { fields: `messages.limit(8){${fields}}`, access_token: t.token });
    if (c.messages?.data) return c.messages.data;
  } catch {}
  const ids = ((await igCall('GET', `/${convId}`, { fields: 'messages.limit(8)', access_token: t.token })).messages?.data || []).map((m) => m.id);
  const out = [];
  for (const id of ids) out.push(await igCall('GET', `/${id}`, { fields, access_token: t.token }).catch(() => ({ id })));
  return out;
}

const mediaIdsOf = (m) => {
  const ids = [];
  if (m.reply_to?.story?.id) ids.push(m.reply_to.story.id);
  if (m.story?.reply_to?.id) ids.push(m.story.reply_to.id);
  for (const a of m.attachments?.data || []) {
    const pl = a.payload || {};
    for (const v of [pl.ig_post_media_id, pl.media_id, pl.reel_video_id, a.id]) if (v && /^\d{6,}$/.test(String(v))) ids.push(String(v));
  }
  for (const sh of m.shares?.data || []) if (sh.id && /^\d{6,}$/.test(String(sh.id))) ids.push(String(sh.id));
  return [...new Set(ids)];
};
const imageOf = (m) => (m.attachments?.data || []).map((a) => a.image_data?.url || (a.type === 'image' || a.mime_type?.startsWith?.('image') ? a.payload?.url || a.file_url : null)).find(Boolean) || null;
const shareTitleOf = (m) => (m.attachments?.data || []).map((a) => a.payload?.title || a.title || '').find((x) => /🛍/.test(x)) || '';

async function answerDm(slot, t, cfg, s, igsid, batch, discounts, deadline) {
  const tag = `igdm:rate:${slot}:${igsid}:${new Date().toISOString().slice(0, 13)}`;
  const n = Number(await r().incr(db.K.flag(tag)).catch(() => 0)) || 0;
  if (n === 1) await r().expire(db.K.flag(tag), 3600).catch(() => {});
  if (n > 4) return { skipped: 'limit' };
  const who = batch[0]?.from?.username || igsid;
  // 1) the post / Reel / story the customer shared or answered
  let shared = false;
  for (const m of batch) {
    if (mediaIdsOf(m).length) shared = true;
    for (const id of mediaIdsOf(m)) {
      const f = await productOfMedia(id, t, s);
      const card = f?.pid ? await productCard(f.pid, s, discounts) : f?.p ? await cardOf(f.p, s, discounts) : null;
      if (card) {
        await sendCard(slot, t, igsid, card);
        await log({ slot, kind: 'dm', who, what: 'post', product: card.name });
        return { sent: 1 };
      }
    }
    const title = shareTitleOf(m).split('\n').find((l) => /🛍/.test(l))?.replace(/🛍/g, '').trim();
    if (title) {
      const f = await findByName(title, { limit: 1 }).catch(() => ({ results: [] }));
      if (f.results[0]) {
        const card = await cardOf(f.results[0], s, discounts);
        await sendCard(slot, t, igsid, card);
        await log({ slot, kind: 'dm', who, what: 'share', product: card.name });
        return { sent: 1 };
      }
    }
  }
  // 2) a photo
  const img = batch.map(imageOf).find(Boolean);
  if (img && Date.now() + 60000 < deadline) {
    try {
      const bytes = await downloadImage(img);
      const f = await findByPhoto(bytes);
      if (f.results.length) {
        for (const { p } of f.results.slice(0, 2)) await sendCard(slot, t, igsid, await cardOf(p, s, discounts));
        await log({ slot, kind: 'dm', who, what: 'photo', product: f.results.map((x) => x.p.name).slice(0, 2).join(', ') });
        return { sent: 1 };
      }
    } catch (e) {
      console.error(`igdm photo: ${errText(e)}`);
    }
    await send(slot, t, { id: igsid }, { text: cfg.not_found });
    await log({ slot, kind: 'dm', who, what: 'photo', product: '— topilmadi' });
    return { sent: 1 };
  }
  // 3) text: a product name / SKU, or just "narxi?"
  const text = batch.map((m) => m.message || '').filter(Boolean).reverse().join(' ').trim();
  if (!text && !shared) return { skipped: 'empty' };
  let q = text.toLowerCase();
  for (const k of kw(cfg)) q = q.split(k).join(' ');
  q = q.replace(/[?!.,:;()"'«»]+/g, ' ').replace(/\b(salom|assalomu|alaykum|aleykum|privet|здравствуйте|привет|bormi|bor|mi|bu|shu|uchun|iltimos|пожалуйста|есть|ли|это|какая|какой|the|a|is)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (q.length >= 3) {
    const f = await findByName(q, { limit: 2 }).catch(() => ({ results: [] }));
    if (f.results.length) {
      for (const p of f.results.slice(0, 2)) await sendCard(slot, t, igsid, await cardOf(p, s, discounts));
      await log({ slot, kind: 'dm', who, what: `«${text.slice(0, 40)}»`, product: f.results.map((p) => p.name).slice(0, 2).join(', ') });
      return { sent: 1 };
    }
  }
  // nothing to show: a greeting / question — once in 12 hours per customer
  if (!(await db.once(`igdm:greet:${slot}:${igsid}`, 12 * 3600))) return { skipped: 'greeted' };
  await send(slot, t, { id: igsid }, { text: q.length >= 3 && !wantsPrice(text, cfg) ? cfg.not_found : cfg.greet });
  await log({ slot, kind: 'dm', who, what: `«${text.slice(0, 40)}»`, product: '— savol' });
  return { sent: 1 };
}

async function pollDm(slot, t, cfg, s, discounts, deadline) {
  const out = { seen: 0, sent: 0 };
  const cur = Number(await r().get(CUR(slot))) || 0;
  if (!cur) {
    await r().set(CUR(slot), Date.now()); // first run: older chats are history
    return out;
  }
  const conv = (await igCall('GET', `/${t.user_id}/conversations`, { platform: 'instagram', fields: 'id,updated_time', limit: 15, access_token: t.token })).data || [];
  const bot = (await r().hgetall(BOT(slot)).catch(() => null)) || {};
  let newest = cur;
  for (const c of conv) {
    const upd = Date.parse(c.updated_time) || 0;
    if (upd <= cur) continue;
    newest = Math.max(newest, upd);
    if (Date.now() + 25000 > deadline) break;
    const msgs = await messagesOf(c.id, t).catch(() => []);
    // newest first: the customer's messages since the shop's last message
    const batch = [];
    let human = false;
    for (const m of msgs) {
      const mine = String(m.from?.id) === String(t.user_id) || (t.username && m.from?.username === t.username);
      if (mine) {
        if (!bot[m.id] && Date.now() - Date.parse(m.created_time) < cfg.human_pause_min * 60000) human = true;
        break;
      }
      if (Date.parse(m.created_time) <= cur) break;
      batch.push(m);
    }
    if (!batch.length) continue;
    if (!(await db.once(`igdm:m:${batch[0].id}`, 7 * 86400))) continue;
    out.seen++;
    const igsid = batch[0].from?.id;
    if (!igsid) continue;
    if (human) {
      await log({ slot, kind: 'dm', who: batch[0].from?.username || igsid, what: 'operator yozishmoqda', product: '— bot jim' });
      continue;
    }
    try {
      const res = await answerDm(slot, t, cfg, s, igsid, batch, discounts, deadline);
      out.sent += res.sent || 0;
      if (res.sent) await db.incrStat('igdm_dm').catch(() => {});
    } catch (e) {
      console.error(`igdm dm ${slot}: ${errText(e)}`);
      await log({ slot, kind: 'dm', who: batch[0].from?.username || igsid, what: 'xato', product: errText(e).slice(0, 120) });
    }
  }
  await r().set(CUR(slot), newest);
  return out;
}

// ---- comments ----

async function pollComments(slot, t, cfg, s, discounts, deadline) {
  const out = { seen: 0, sent: 0 };
  const curKey = F(`ccur:${slot}`);
  const cur = Number(await r().get(curKey)) || 0;
  if (!cur) {
    await r().set(curKey, Date.now());
    return out;
  }
  const media = ((await igCall('GET', `/${t.user_id}/media`, { fields: 'id,timestamp,comments_count', limit: 12, access_token: t.token })).data || []).filter((m) => m.comments_count > 0 && Date.now() - Date.parse(m.timestamp) < 14 * 86400000);
  let newest = cur;
  for (const m of media) {
    if (Date.now() + 20000 > deadline) break;
    const cm = (await igCall('GET', `/${m.id}/comments`, { fields: 'id,text,timestamp,from,username', limit: 30, access_token: t.token }).catch(() => ({ data: [] }))).data || [];
    for (const c of cm) {
      const at = Date.parse(c.timestamp) || 0;
      if (at <= cur) continue;
      newest = Math.max(newest, at);
      const fromId = c.from?.id;
      if (String(fromId) === String(t.user_id) || c.username === t.username) continue;
      if (!wantsPrice(c.text, cfg)) continue;
      if (!(await db.once(`igdm:c:${c.id}`, 30 * 86400))) continue;
      out.seen++;
      try {
        const f = await productOfMedia(m.id, t, s);
        const card = f?.pid ? await productCard(f.pid, s, discounts) : f?.p ? await cardOf(f.p, s, discounts) : null;
        await send(slot, t, { comment_id: c.id }, { text: card ? card.text : cfg.greet });
        if (cfg.public_reply) await igCall('POST', `/${c.id}/replies`, { message: cfg.public_reply, access_token: t.token }).catch((e) => console.error(`igdm reply: ${errText(e)}`));
        out.sent++;
        await db.incrStat('igdm_comment').catch(() => {});
        await log({ slot, kind: 'comment', who: c.username || c.from?.username || '', what: `«${String(c.text).slice(0, 40)}»`, product: card?.name || '— post topilmadi' });
      } catch (e) {
        console.error(`igdm comment ${slot}: ${errText(e)}`);
        await log({ slot, kind: 'comment', who: c.username || '', what: 'xato', product: errText(e).slice(0, 120) });
      }
    }
  }
  await r().set(curKey, newest);
  return out;
}

// ---- one pass / loop ----

export async function igdmPoll(s, { deadline = Date.now() + 50000 } = {}) {
  const cfg = dmCfg(s);
  const out = {};
  if (!db.hasRedis() || !cfg.on) return { off: true };
  const discounts = await loadDiscounts().catch(() => null);
  for (const slot of SLOTS) {
    if (!cfg.slots.includes(slot)) continue;
    const t = await tokenOf(slot);
    if (!t?.token) continue;
    const st = {};
    if (cfg.dm) {
      try {
        out[`dm_${slot}`] = await pollDm(slot, t, cfg, s, discounts, deadline);
        st.dm_ok = Date.now();
        st.dm_error = null;
      } catch (e) {
        st.dm_error = errText(e).slice(0, 300);
        st.dm_error_at = Date.now();
      }
    }
    if (cfg.comments && Date.now() + 15000 < deadline) {
      try {
        out[`cm_${slot}`] = await pollComments(slot, t, cfg, s, discounts, deadline);
        st.cm_ok = Date.now();
        st.cm_error = null;
      } catch (e) {
        st.cm_error = errText(e).slice(0, 300);
        st.cm_error_at = Date.now();
      }
    }
    const prev = (await r().hget(ST(), slot).catch(() => null)) || {};
    await r().hset(ST(), { [slot]: { ...prev, ...st } }).catch(() => {});
  }
  return out;
}

export function igdmUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
  return host ? `${/^https?:\/\//i.test(host) ? host : `https://${host}`}/api/igdm` : '';
}
export async function kickIgdmLoop(s) {
  if (!dmCfg(s).on) return { skipped: 'off' };
  const url = igdmUrl();
  const headers = {};
  if (process.env.CRON_SECRET) headers.Authorization = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.SECRET) headers['x-secret'] = process.env.SECRET;
  if (!url || !Object.keys(headers).length) return { skipped: 'no kick' };
  const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) });
  return { status: res.status };
}

// /api/igdm: a pass about once a minute for ~4 minutes, then the route is asked to continue
export async function keepIgdmFresh({ budget = 240000, every = 60000 } = {}) {
  let s = await db.getSettings();
  if (!dmCfg(s).on || !db.hasRedis()) return { skipped: 'off' };
  if (!(await db.lock(LOOP, 150))) return { skipped: 'running' };
  const start = Date.now();
  let polls = 0;
  let again = true;
  try {
    while (Date.now() - start < budget) {
      if (polls) s = await db.getSettings();
      if (!dmCfg(s).on) {
        again = false;
        break;
      }
      const began = Date.now();
      await igdmPoll(s, { deadline: began + 55000 }).catch((e) => console.error(`igdm poll: ${errText(e)}`));
      polls++;
      await r().set(db.K.flag(`lock:${LOOP}`), 1, { ex: 150 }).catch(() => {});
      const wait = every - (Date.now() - began);
      if (Date.now() + Math.max(0, wait) - start >= budget) break;
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }
  } finally {
    await db.unlock(LOOP).catch(() => {});
  }
  const next = again ? await kickIgdmLoop(s).catch((e) => ({ error: errText(e) })) : null;
  return { polls, next };
}

// ---- dashboard ----

export async function igdmView(s) {
  const [st, logs] = await Promise.all([r().hgetall(ST()).catch(() => null), r().lrange(LOG(), 0, 29).catch(() => [])]);
  const accounts = [];
  for (const slot of SLOTS) {
    const t = await tokenOf(slot);
    if (t?.token) accounts.push({ slot, username: t.username || '' });
  }
  const today = await db.getStats();
  return { ok: true, cfg: dmCfg(s), status: st || {}, log: logs || [], accounts, today: { dm: Number(today.igdm_dm) || 0, comment: Number(today.igdm_comment) || 0 } };
}

export async function igdmSetCfg(body = {}) {
  const s = await db.getSettings();
  const cur = dmCfg(s);
  const txt = (v, d, max) => (v == null ? d : String(v).trim().slice(0, max));
  const next = {
    on: 'on' in body ? Boolean(body.on) : cur.on,
    slots: Array.isArray(body.slots) ? body.slots.filter((x) => SLOTS.includes(x)) : cur.slots,
    dm: 'dm' in body ? Boolean(body.dm) : cur.dm,
    comments: 'comments' in body ? Boolean(body.comments) : cur.comments,
    keywords: txt(body.keywords, cur.keywords, 600) || DM_DEFAULTS.keywords,
    public_reply: txt(body.public_reply, cur.public_reply, 300),
    greet: txt(body.greet, cur.greet, 600) || DM_DEFAULTS.greet,
    not_found: txt(body.not_found, cur.not_found, 600) || DM_DEFAULTS.not_found,
    human_pause_min: Math.min(1440, Math.max(0, Math.round(Number(body.human_pause_min ?? cur.human_pause_min)) || 0)),
  };
  await db.updateSettings({ igdm: next });
  if (next.on && !cur.on) await kickIgdmLoop({ igdm: next }).catch(() => {});
  return { ok: true, message: next.on ? '💾 Saqlandi — bot Direct va izohlarni har daqiqada tekshiradi' : '💾 Saqlandi (o\'chiq)', cfg: next };
}

// "🧪 Tekshirish": can the token read Direct and comments?
export async function igdmCheck(slot) {
  const t = await tokenOf(slot);
  if (!t?.token) return { ok: false, message: 'Akkaunt ulanmagan' };
  const res = [];
  try {
    const c = await igCall('GET', `/${t.user_id}/conversations`, { platform: 'instagram', fields: 'id,updated_time', limit: 3, access_token: t.token });
    res.push(`✅ Direct o'qiladi (${(c.data || []).length} ta suhbat)`);
  } catch (e) {
    res.push(`❌ Direct: ${errText(e).slice(0, 160)} — tokenda instagram_business_manage_messages ruxsati kerak`);
  }
  try {
    const m = (await igCall('GET', `/${t.user_id}/media`, { fields: 'id', limit: 1, access_token: t.token })).data?.[0];
    if (m) await igCall('GET', `/${m.id}/comments`, { fields: 'id', limit: 1, access_token: t.token });
    res.push("✅ Izohlar o'qiladi");
  } catch (e) {
    res.push(`❌ Izohlar: ${errText(e).slice(0, 160)} — tokenda instagram_business_manage_comments ruxsati kerak`);
  }
  return { ok: !res.some((x) => x.startsWith('❌')), message: `@${t.username}: ${res.join(' · ')}` };
}
