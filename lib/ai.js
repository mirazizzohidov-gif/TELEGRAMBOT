// "🤖 AI tavsif": a short Uzbek (Latin) selling description of a product, written by Google Gemini from its
// photo and name, shown in customer posts ("📝 ..." under the name). Written once per product and kept in
// Redis; the admin can rewrite it (/tavsif SKU). Without GEMINI_API_KEY, switched off, or on any error
// the post simply goes without a description — posting never waits for or fails because of the AI.

import * as db from './store.js';
import { downloadImage } from './story.js';
import { errText, fetchWithTimeout, mapLimit } from './util.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash'; // Google: gemini-2.5-flash is closed to new users
const MAX_LEN = 110; // AI: one short, to-the-point sentence
const ADMIN_MAX_LEN = 300; // written by the admin (/tavsif → ✏️)
// Style of the AI text; a saved AI description of an older style is rewritten on its next post.
const STYLE_V = 2;
const CALL_MS = 25000;

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
    const jpeg = await sharp(await downloadImage(url)).rotate().resize(768, 768, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
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
  const r = await fetchWithTimeout(
    `${API}/${encodeURIComponent(use)}:generateContent`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(body) },
    CALL_MS,
  );
  const data = await r.json().catch(() => ({}));
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
    throw new Error(`Gemini ${r.status}: ${message}`);
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
    // a failed product is not retried on every post within the hour
    if (!(await db.once(`aitry:${keyOf(item)}`, 60 * 60))) return null;
  }
  try {
    const text = await generateDesc(item);
    await setDesc(item, text);
    await db.incrStat('ai_desc');
    console.log(`ai: description for ${item.sku}: ${text}`);
    return text;
  } catch (e) {
    await db.incrStat('ai_failed');
    console.error(`ai: ${item.sku}: ${errText(e)}`);
    if (force) throw e;
    return null;
  }
}

// Adds `desc` to items that do not have one yet (3 at a time; skipped when time is short).
export async function withDescriptions(items, s, { deadline = Date.now() + 60000 } = {}) {
  if (!aiEnabled(s) || !items.length) return items;
  return mapLimit(items, 3, async (item) => {
    if (item.desc || Date.now() + CALL_MS + 15000 > deadline) return item;
    const desc = await describe(item, s).catch(() => null);
    return desc ? Object.assign(item, { desc }) : item;
  });
}
