// "🤖 AI tavsif": a short Uzbek (Latin) selling description of a product, written by Google Gemini from its
// photo and name, shown in customer posts ("📝 ..." under the name). Written once per product and kept in
// Redis; the admin can rewrite it (/tavsif SKU). Without GEMINI_API_KEY, switched off, or on any error
// the post simply goes without a description — posting never waits for or fails because of the AI.

import * as db from './store.js';
import { downloadImage } from './story.js';
import { buildPostCaption } from './caption.js';
import { tg } from './telegram.js';
import { clock, errText, fetchWithTimeout, mapLimit } from './util.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash'; // Google: gemini-2.5-flash is closed to new users
const MAX_LEN = 110; // AI: one short, to-the-point sentence
const ADMIN_MAX_LEN = 300; // written by the admin (/tavsif → ✏️)
// Style of the AI text; a saved AI description of an older style is rewritten on its next post.
const STYLE_V = 2;
// Gemini 3 models think before answering and are slow under load: one call may take up to 45 s.
const CALL_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 45000;
const BUSY = new Set([429, 500, 503]);
const RETRY_WAITS = [2000, 5000];
const BUSY_PAUSE = 10 * 60; // after a "busy" failure a product waits 10 min (other errors: 1 hour)
const MIN_LEFT_MS = CALL_MS + 5000; // a description is asked for only with this much time left

// GEMINI_MODEL, else the model Google itself pointed to when an old one was retired (saved), else the default.
let savedModel = null;
export async function aiModel() {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (savedModel === null && db.hasRedis()) savedModel = (await db.redis().get(db.K.aiModel).catch(() => null)) || '';
  return savedModel || DEFAULT_MODEL;
}

// "This model models/x is no longer available ... use models/y" -> "y"
export const suggestedModel = (message) => ((String(message).match(/use\s+(?:models\/)?(gemini-[\w.-]+)/i) || [])[1] || '').replace(/[.-]+$/, '') || null;
export const aiConfigured = () => Boolean(process.env.GEMINI_API_KEY);
export const aiEnabled = (s) => aiConfigured() && s.ai_desc !== false;

const PROMPT = (name) =>
  [
    "Sen sovg'a va aksessuarlar do'konining Telegram kanali uchun mahsulot tavsifini yozasan.",
    `Mahsulot nomi: "${name}". Rasmga ham qara.`,
    "Faqat o'zbek tilida (lotin yozuvida) BITTA qisqa va lo'nda gap yoz (8-14 so'z): mahsulot nima va uning asosiy foydasi.",
    "Misol: Sovg'a va telefonni bezash uchun yaltiroq 3D stikerlar.",
    `Qoidalar: ${MAX_LEN} belgidan oshmasin; ortiqcha maqtov va umumiy so'zlarsiz; narx, telefon, chegirma, havola yozma; emoji, qo'shtirnoq, markdown ishlatma; ` +
      "mahsulot nomini so'zma-so'z takrorlama; rasmda aniq ko'rinmagan narsani o'ylab topma.",
    'Faqat tavsif matnini qaytar.',
  ].join('\n');

// Gemini's text answer -> one clean line of at most MAX_LEN characters.
export function cleanDesc(text, max = MAX_LEN) {
  let t = String(text || '')
    .replace(/[*_`#>]/g, '')
    .replace(/^["'«»“”\s]+|["'«»“”\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
    t = end > max / 3 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
  }
  return t;
}

async function photoPart(url) {
  if (!url) return null;
  try {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp(await downloadImage(url)).rotate().resize(512, 512, { fit: 'inside' }).jpeg({ quality: 75 }).toBuffer();
    return { inline_data: { mime_type: 'image/jpeg', data: jpeg.toString('base64') } };
  } catch (e) {
    console.error(`ai: photo not used (${errText(e)})`);
    return null;
  }
}

// One Gemini call. Throws with Google's error message on failure (the key is never logged).
export async function generateDesc(item, { model = null, retried = false } = {}) {
  const photo = await photoPart(item.image_url);
  const use = model || (await aiModel());
  const body = {
    contents: [{ role: 'user', parts: [{ text: PROMPT(item.name) }, ...(photo ? [photo] : [])] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  };
  // Google busy (503 "high demand", 429, 500): wait a little and try again, twice.
  let r;
  let data;
  for (let attempt = 0; ; attempt++) {
    r = await fetchWithTimeout(
      `${API}/${encodeURIComponent(use)}:generateContent`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(body) },
      CALL_MS,
    );
    data = await r.json().catch(() => ({}));
    if (!BUSY.has(r.status) || attempt >= RETRY_WAITS.length) break;
    console.log(`ai: Gemini ${r.status} (busy), retry in ${RETRY_WAITS[attempt]} ms`);
    await clock.sleep(RETRY_WAITS[attempt]);
  }
  if (!r.ok || data.error) {
    const message = data.error?.message || 'xato';
    // A retired model: switch to the one Google names, remember it, try once more.
    const next = r.status === 404 && !retried && !process.env.GEMINI_MODEL ? suggestedModel(message) : null;
    if (next && next !== use) {
      console.log(`ai: model ${use} retired, using ${next}`);
      savedModel = next;
      if (db.hasRedis()) await db.redis().set(db.K.aiModel, next).catch(() => {});
      return generateDesc(item, { model: next, retried: true });
    }
    throw Object.assign(new Error(`Gemini ${r.status}: ${message}`), { status: r.status });
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(' ');
  const desc = cleanDesc(text);
  if (!desc) throw new Error(`Gemini: bo'sh javob (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'sabab yo\'q'})`);
  return desc;
}

const keyOf = (item) => String(item.product_id || item.sku);

export async function getDesc(item) {
  if (!db.hasRedis()) return null;
  return (await db.redis().hget(db.K.aiDesc, keyOf(item))) || null;
}

export async function setDesc(item, text, by = 'ai') {
  const rec = { text: cleanDesc(text, by === 'admin' ? ADMIN_MAX_LEN : MAX_LEN), by, sku: String(item.sku), at: Date.now(), v: STYLE_V };
  await db.redis().hset(db.K.aiDesc, { [keyOf(item)]: rec });
  return rec;
}

export const dropDesc = (item) => db.redis().hdel(db.K.aiDesc, keyOf(item));

// The description for a post: the saved one, otherwise written now (and saved). null when off / failed.
export async function describe(item, s, { force = false } = {}) {
  if (!aiEnabled(s) || !db.hasRedis()) return null;
  if (!force) {
    const saved = await getDesc(item);
    // the admin's own text always; an AI text only of the current style (older ones are rewritten)
    if (saved?.text && (saved.by === 'admin' || saved.v === STYLE_V)) return saved.text;
    // a product whose description just failed is not retried on every post within the hour
    if (await db.redis().get(db.K.flag(`aifail:${keyOf(item)}`))) {
      await db.incrStat('ai_skipped');
      return null;
    }
  }
  try {
    const text = await generateDesc(item);
    await setDesc(item, text);
    await db.incrStat('ai_desc');
    await db.redis().set(db.K.aiLast, { at: Date.now(), sku: String(item.sku), ok: true, text }).catch(() => {});
    console.log(`ai: description for ${item.sku}: ${text}`);
    return text;
  } catch (e) {
    await db.incrStat('ai_failed');
    // busy / slow (503, 429, 500, timeout): try again in 10 minutes; other errors in an hour
    const transient = BUSY.has(e.status) || /^Timeout|abort/i.test(errText(e));
    await db.redis().set(db.K.flag(`aifail:${keyOf(item)}`), 1, { ex: transient ? BUSY_PAUSE : 60 * 60 }).catch(() => {});
    await db.redis().set(db.K.aiLast, { at: Date.now(), sku: String(item.sku), ok: false, error: errText(e).slice(0, 300) }).catch(() => {});
    console.error(`ai: ${item.sku}: ${errText(e)}`);
    if (force) throw e;
    return null;
  }
}

// Adds `desc` to items that do not have one yet (3 at a time; skipped when time is short).
export async function withDescriptions(items, s, { deadline = Date.now() + 60000 } = {}) {
  if (!aiEnabled(s) || !items.length) return items;
  return mapLimit(items, 3, async (item) => {
    if (item.desc) return item;
    if (Date.now() + MIN_LEFT_MS > deadline) {
      // no time left in this run: counted, so the admin sees it ("vaqt yetmadi")
      await db.incrStat('ai_skipped').catch(() => {});
      console.log(`ai: ${item.sku}: no time left for a description`);
      return item;
    }
    const desc = await describe(item, s).catch(() => null);
    return desc ? Object.assign(item, { desc }) : item;
  });
}

// ---- adding the description afterwards ----
// A post that went out without "📝" (Gemini busy / no time) is remembered; the next ticks write the
// description and edit the post's caption (channel and group posts; stories cannot be edited).
const BACKFILL_MAX = 300;
const BACKFILL_DAYS = 2;
const pick = (i) => ({ product_id: i.product_id, sku: i.sku, name: i.name, image_url: i.image_url, price: i.price, old_price: i.old_price, type: i.type, fresh: i.fresh, stock: i.stock });

export async function rememberForDesc(s, item, msg, chat, { kb = true, show = true } = {}) {
  if (!show || item.desc || !aiEnabled(s) || !msg?.message_id || !db.hasRedis()) return;
  await db.redis().rpush(db.K.aiBackfill, { chat: String(chat), mid: msg.message_id, kb, at: Date.now(), item: pick(item) });
  await db.redis().ltrim(db.K.aiBackfill, -BACKFILL_MAX, -1);
}

export async function backfillDescriptions(s, { deadline = Date.now() + 60000, max = 6 } = {}) {
  const result = { edited: 0, waiting: 0 };
  if (!aiEnabled(s) || !db.hasRedis()) return result;
  const all = (await db.redis().lrange(db.K.aiBackfill, 0, -1)) || [];
  if (!all.length) return result;
  const fresh = all.filter((e) => Date.now() - e.at <= BACKFILL_DAYS * 86400000); // older ones dropped
  const now = fresh.slice(0, max);
  const keep = fresh.slice(max);
  // three at a time (Gemini is slow), as long as the time slice lasts
  await mapLimit(now, 3, async (e) => {
    if (Date.now() + MIN_LEFT_MS > deadline) {
      keep.push(e);
      return;
    }
    const desc = await describe(e.item, s).catch(() => null);
    if (!desc) {
      keep.push(e);
      return;
    }
    const caption = buildPostCaption({ ...e.item, desc }, s.phone, { lowAt: db.limit(s, 'low_stock_threshold') });
    await tg('editMessageCaption', {
      chat_id: e.chat,
      message_id: e.mid,
      caption,
      parse_mode: 'HTML',
      ...(e.kb ? { reply_markup: { inline_keyboard: [[{ text: '🛒 Buyurtma berish', url: s.order_url }]] } } : {}),
    })
      .then(() => {
        result.edited++;
        console.log(`ai: description added to post ${e.chat}/${e.mid} (sku ${e.item.sku})`);
      })
      .catch((err) => console.error(`ai: edit ${e.chat}/${e.mid}: ${errText(err)}`)); // deleted post etc.: dropped
  });
  await db.redis().del(db.K.aiBackfill);
  if (keep.length) await db.redis().rpush(db.K.aiBackfill, ...keep);
  result.waiting = keep.length;
  if (result.edited) await db.incrStat('ai_backfilled', result.edited);
  return result;
}
