// "🤖 AI tavsif": a short Uzbek (Latin) selling description of a product, written by Google Gemini from its
// photo and name, shown in customer posts ("📝 ..." under the name). Written once per product and kept in
// Redis; the admin can rewrite it (/tavsif SKU). Without GEMINI_API_KEY, switched off, or on any error
// the post simply goes without a description — posting never waits for or fails because of the AI.

import * as db from './store.js';
import { downloadImage } from './story.js';
import { buildPostCaption } from './caption.js';
import { tg } from './telegram.js';
import { withTags } from './hashtags.js';
import { orderLink } from './orders.js';
import { setPostDesc } from './postreg.js';
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
export const aiConfigured = () => Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY);
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

// An image as a Gemini part (downscaled JPEG). `size` px on the longer side.
export async function imagePart(input, size = 512) {
  const sharp = (await import('sharp')).default;
  const buf = Buffer.isBuffer(input) ? input : await downloadImage(input);
  const jpeg = await sharp(buf).rotate().resize(size, size, { fit: 'inside' }).jpeg({ quality: 75 }).toBuffer();
  return { inline_data: { mime_type: 'image/jpeg', data: jpeg.toString('base64') } };
}

async function photoPart(url) {
  if (!url) return null;
  try {
    return await imagePart(url, 512);
  } catch (e) {
    console.error(`ai: photo not used (${errText(e)})`);
    return null;
  }
}

// Zaxira modellar: the main model's free quota (e.g. 20 a day) is used up -> the next one answers.
// Every model has its own free quota. GEMINI_FALLBACK_MODELS (comma separated) replaces the list; a model
// that does not exist (404) is skipped for a day.
// No list given: the models this API key can use are asked from Google once a day (models.list) and the
// text models among them (flash / flash-lite / pro / gemma) become the fallbacks, cheapest first.
const ENV_FALLBACKS = process.env.GEMINI_FALLBACK_MODELS
  ? process.env.GEMINI_FALLBACK_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
  : null;
let modelList = null;
export function pickFallbacks(names) {
  const skip = /image|tts|audio|live|embed|vision|aqa|imagen|veo|learnlm|robotics|computer|native|exp|preview/i;
  const ok = [...new Set(names.map((n) => String(n).replace(/^models\//, '')))].filter((n) => /^(gemini|gemma)-/i.test(n) && !skip.test(n));
  const rank = (n) => (/flash-lite/i.test(n) ? 0 : /flash/i.test(n) ? 1 : /gemma/i.test(n) ? 2 : 3);
  const ver = (n) => Number((n.match(/-(\d+(?:\.\d+)?)/) || [])[1]) || 0;
  return ok.sort((a, b) => rank(a) - rank(b) || ver(b) - ver(a) || a.localeCompare(b)).slice(0, 8);
}
async function fallbackModels() {
  if (ENV_FALLBACKS) return ENV_FALLBACKS;
  if (modelList) return modelList;
  const KEY = db.K.flag('ai:models');
  const saved = db.hasRedis() ? await db.redis().get(KEY).catch(() => null) : null;
  if (Array.isArray(saved)) return (modelList = saved);
  try {
    const r = await fetchWithTimeout(`${API}?pageSize=200`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } }, 10000);
    const d = await r.json().catch(() => ({}));
    const names = (d.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name);
    modelList = pickFallbacks(names);
    console.log(`ai: fallback models from Google: ${modelList.join(', ') || '—'}`);
    if (db.hasRedis()) await db.redis().set(KEY, modelList, { ex: 86400 }).catch(() => {});
  } catch (e) {
    console.error(`ai: model list failed: ${errText(e)}`);
    modelList = [];
  }
  return modelList;
}
const QUOTA_KEY = (m) => db.K.flag(`aiquota:${m}`);
// "Please retry in 2h7m12.49s" -> seconds
export function retrySeconds(message) {
  const m = String(message || '').match(/retry in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i);
  if (!m) return null;
  const sec = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + Math.ceil(Number(m[3]) || 0);
  return sec || null;
}
export const isQuotaError = (status, message) => status === 429 && /quota/i.test(String(message || ''));
async function modelResting(m) {
  if (!db.hasRedis()) return false;
  return Boolean(await db.redis().get(QUOTA_KEY(m)).catch(() => null));
}
async function restModel(m, sec) {
  if (db.hasRedis()) await db.redis().set(QUOTA_KEY(m), 1, { ex: Math.max(60, Math.min(86400, Math.round(sec))) }).catch(() => {});
}
export let lastModelUsed = null;

// The main model, then the fallbacks: a model whose quota is used up rests until Google says it is back
// ("retry in …"), and the next one in the list is asked.
export async function callGemini(parts, opts = {}) {
  if (opts.model) return callModel(parts, opts);
  let lastErr = null;
  if (process.env.GEMINI_API_KEY) {
    try {
      return await geminiChain(parts, opts);
    } catch (e) {
      lastErr = e;
    }
  }
  // Gemini used up / busy / failing: the other AI providers in turn (GROQ_API_KEY, OPENROUTER_API_KEY)
  for (const p of PROVIDERS) {
    if (!process.env[p.env] || (await modelResting(p.id))) continue;
    try {
      const text = await callProvider(p, parts, opts);
      if (lastErr) console.log(`ai: answered by ${lastModelUsed} (before: ${errText(lastErr).slice(0, 80)})`);
      return text;
    } catch (e) {
      lastErr = e;
      console.error(`ai: ${p.name}: ${errText(e)}`);
      if (e.status === 429) await restModel(p.id, e.retrySec || 600);
      else if (e.status === 401 || e.status === 403) await restModel(p.id, 3600);
    }
  }
  throw lastErr || new Error("AI kaliti yo'q (GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY)");
}

async function geminiChain(parts, opts) {
  const main = await aiModel();
  const chain = [main, ...(await fallbackModels()).filter((m) => m !== main)];
  let lastErr = null;
  for (const [i, m] of chain.entries()) {
    if (await modelResting(m)) continue;
    try {
      const text = await callModel(parts, { ...opts, model: m, retried: i > 0 });
      lastModelUsed = m;
      return text;
    } catch (e) {
      lastErr = e;
      if (e.quota) {
        const sec = e.retrySec || (/per day/i.test(e.message) ? 6 * 3600 : 120);
        await restModel(m, sec);
        console.log(`ai: ${m} quota used up, resting ${Math.round(sec / 60)} min — trying the next model`);
        continue;
      }
      // a fallback that does not exist / cannot do this request: the next one
      if (i > 0 && (e.status === 404 || e.status === 400)) {
        if (e.status === 404) await restModel(m, 86400);
        console.log(`ai: fallback ${m} not usable (${e.status})`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || Object.assign(new Error("Gemini 429: hamma modellarning bepul limiti tugagan"), { status: 429, quota: true });
}

// ---- other providers (OpenAI-style chat API) ----
// Groq: fast, free tier per minute / day; its model list is read from the API (a vision model gets the
// photo, otherwise the text goes alone). OpenRouter: "openrouter/free" picks a free model by itself.
const PROVIDERS = [
  { id: 'groq', name: 'Groq', env: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions', list: 'https://api.groq.com/openai/v1/models', model: () => groqModel() },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    env: 'OPENROUTER_API_KEY',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { 'X-Title': 'Mixpodarok bot' },
    model: async () => ({ id: process.env.OPENROUTER_MODEL || 'openrouter/free', vision: true }),
  },
];

let groqList = null;
export function pickGroq(ids) {
  const skip = /whisper|tts|guard|embed|playai|orpheus|compound|distil|prompt|safeguard/i;
  const ok = ids.filter((m) => !skip.test(m));
  const vision = ok.find((m) => /llama-4|vision|scout|maverick/i.test(m)) || null;
  const order = [/gpt-oss-120b/i, /llama-3\.3-70b/i, /qwen/i, /kimi/i, /gpt-oss/i, /llama/i];
  const text = order.map((re) => ok.find((m) => re.test(m))).find(Boolean) || ok[0] || null;
  return { vision, text };
}
async function groqModel() {
  if (process.env.GROQ_MODEL) return { id: process.env.GROQ_MODEL, vision: /llama-4|vision|scout|maverick/i.test(process.env.GROQ_MODEL) };
  if (!groqList) {
    const KEY = db.K.flag('ai:groq');
    groqList = db.hasRedis() ? await db.redis().get(KEY).catch(() => null) : null;
    if (!groqList) {
      const r = await fetchWithTimeout(PROVIDERS[0].list, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }, 10000);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(`Groq ${r.status}: ${d.error?.message || 'model list'}`), { status: r.status });
      groqList = pickGroq((d.data || []).filter((m) => m.active !== false).map((m) => m.id));
      console.log(`ai: Groq models: vision ${groqList.vision || '—'}, text ${groqList.text || '—'}`);
      if (db.hasRedis()) await db.redis().set(KEY, groqList, { ex: 86400 }).catch(() => {});
    }
  }
  return { id: null, ...groqList };
}

async function callProvider(p, parts, { json = false, temperature = 0.7 } = {}) {
  const text = parts.filter((x) => x.text).map((x) => x.text).join('\n\n');
  const imgs = parts.filter((x) => x.inline_data).map((x) => ({ type: 'image_url', image_url: { url: `data:${x.inline_data.mime_type};base64,${x.inline_data.data}` } }));
  const m = await p.model();
  const send = async (model, withImg, withFmt) => {
    const content = withImg && imgs.length ? [{ type: 'text', text }, ...imgs] : imgs.length ? `${text}\n\n(Rasm berilmagan — faqat nomiga qarab yoz.)` : text;
    const r = await fetchWithTimeout(
      p.url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env[p.env]}`, ...(p.headers || {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature, max_tokens: 1024, ...(json && withFmt ? { response_format: { type: 'json_object' } } : {}) }),
      },
      CALL_MS,
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      const msg = data.error?.message || data.error || 'xato';
      throw Object.assign(new Error(`${p.name} ${r.status} (${model}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`), { status: r.status || 500, retrySec: Number(r.headers?.get?.('retry-after')) || null });
    }
    const out = String(data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!out) throw Object.assign(new Error(`${p.name}: bo'sh javob`), { status: 502 });
    lastModelUsed = `${p.id}:${data.model || model}`;
    return out;
  };
  // the photo when the model can see it; a refused photo / JSON format -> plain text
  const vision = m.id ? m.vision : Boolean(m.vision);
  const first = m.id || (imgs.length && m.vision ? m.vision : m.text);
  if (!first) throw new Error(`${p.name}: model topilmadi`);
  try {
    return await send(first, imgs.length > 0 && (m.id ? vision : first === m.vision), true);
  } catch (e) {
    if (![400, 404, 413, 422].includes(e.status)) throw e;
    const second = m.id || m.text || first;
    return send(second, false, false);
  }
}

// One generateContent call with one model: busy answers (503 / 429 / 500) are retried after
// 2 s and 5 s (a used-up quota is not), a retired model (404 "… use models/X") is replaced by X
// (remembered). Returns the text. opts.json: ask for a JSON answer. Errors carry Google's message,
// the HTTP status and, for a used-up quota, quota + retrySec.
async function callModel(parts, { json = false, temperature = 0.7, model = null, retried = false } = {}) {
  const use = model || (await aiModel());
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, maxOutputTokens: 2048, ...(json ? { responseMimeType: 'application/json' } : {}) },
  };
  let r;
  let data;
  for (let attempt = 0; ; attempt++) {
    r = await fetchWithTimeout(
      `${API}/${encodeURIComponent(use)}:generateContent`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(body) },
      CALL_MS,
    );
    data = await r.json().catch(() => ({}));
    if (!BUSY.has(r.status) || attempt >= RETRY_WAITS.length || isQuotaError(r.status, data.error?.message)) break;
    console.log(`ai: Gemini ${r.status} (busy), retry in ${RETRY_WAITS[attempt]} ms`);
    await clock.sleep(RETRY_WAITS[attempt]);
  }
  if (!r.ok || data.error) {
    const message = data.error?.message || 'xato';
    const next = r.status === 404 && !retried && !process.env.GEMINI_MODEL ? suggestedModel(message) : null;
    if (next && next !== use) {
      console.log(`ai: model ${use} retired, using ${next}`);
      savedModel = next;
      if (db.hasRedis()) await db.redis().set(db.K.aiModel, next).catch(() => {});
      return callModel(parts, { json, temperature, model: next, retried: true });
    }
    const quota = isQuotaError(r.status, message);
    throw Object.assign(new Error(`Gemini ${r.status} (${use}): ${message}`), { status: r.status, ...(quota ? { quota, retrySec: retrySeconds(message) } : {}) });
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(' ').trim();
  if (!text) throw new Error(`Gemini: bo'sh javob (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "sabab yo'q"})`);
  return text;
}

// A JSON answer (also when Gemini wraps it in ```json … ```).
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/[\[{][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* falls through */
      }
    }
    return null;
  }
}

export async function generateDesc(item) {
  const photo = await photoPart(item.image_url);
  const desc = cleanDesc(await callGemini([{ text: PROMPT(item.name) }, ...(photo ? [photo] : [])]));
  if (!desc) throw new Error("Gemini: bo'sh javob");
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
const pick = (i) => ({ product_id: i.product_id, sku: i.sku, name: i.name, image_url: i.image_url, price: i.price, old_price: i.old_price, type: i.type, fresh: i.fresh, stock: i.stock, tags: i.tags });

export async function rememberForDesc(s, item, msg, chat, { kb = true, show = true } = {}) {
  if (!show || item.desc || !aiEnabled(s) || !msg?.message_id || !db.hasRedis()) return;
  // the post's own phone and button (the 2nd channel has its own)
  await db.redis().rpush(db.K.aiBackfill, { chat: String(chat), mid: msg.message_id, kb, at: Date.now(), item: pick(item), phone: s.phone, url: orderLink(s, item) });
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
    // a post already marked "❌ SOTILDI" keeps its mark; the description is kept for its later edits
    const reg = await setPostDesc(e.item.product_id, e.chat, e.mid, desc).catch(() => null);
    if (reg?.sold) return;
    const caption = withTags(buildPostCaption({ ...e.item, desc }, e.phone || s.phone, { lowAt: db.limit(s, 'low_stock_threshold') }), e.item.tags);
    await tg('editMessageCaption', {
      chat_id: e.chat,
      message_id: e.mid,
      caption,
      parse_mode: 'HTML',
      ...(e.kb ? { reply_markup: { inline_keyboard: [[{ text: '🛒 Buyurtma berish', url: e.url || orderLink(s, e.item) }]] } } : {}),
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
