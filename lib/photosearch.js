// "📷 Rasm bo'yicha qidirish": a photo sent to the bot -> the product in BITO.
// 1) Gemini reads what is written on it (barcode / SKU / label) -> exact BITO lookup;
// 2) otherwise Gemini names the product with a few search words -> BITO search -> Gemini compares the
//    photo with the candidates' BITO photos and picks the closest (up to 3).
// Staff (admins, stock groups) get SKU, price and stock; customers get the customer card (price,
// "🛒 Buyurtma berish" or "🔔 Kelganda xabar ber").

import { aiConfigured, callGemini, imagePart, parseJson } from './ai.js';
import { findBySku, formatPrice, getProductsPage, imageUrl, loadDiscounts, priceFor, productImage, productStock } from './bito.js';
import { getRecord, outDateText } from './stock.js';
import * as db from './store.js';
import { downloadImage } from './story.js';
import { tg } from './telegram.js';
import { errText, mapLimit } from './util.js';
import { card } from './waitlist.js';

export const PHOTO_BUTTON = "📷 Rasm bo'yicha qidirish";
export const PHOTO_PROMPT = "📷 Mahsulot rasmini yuboring (shu xabarga javob qilib) — BITO'dan topib beraman.";
const CUSTOMER_DAILY = 20; // searches per customer per day
const CANDIDATES = 12;
const SHOW = 3;
const MIN_SCORE = 35;

const isTradable = (p) => p && p.is_product !== false && !p.is_archived && !p.is_deleted && !p.completely_deleted;
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const photoSearchOn = (s) => aiConfigured() && s.ai_desc !== false && s.photo_search !== false;

const READ_PROMPT = [
  "Bu rasmda sovg'a / aksessuar do'konidagi bitta mahsulot bor. Uni do'kon bazasidan qidirish kerak.",
  'JSON qaytar: {"codes": [...], "words": [...], "what": "..."}',
  '- codes: rasmda ko\'rinadigan shtrix-kod raqamlari, artikul / SKU raqamlari (faqat aniq o\'qilganlari, raqam sifatida matn).',
  "- words: bazadan qidirish uchun 3-6 ta qisqa so'z yoki ibora; mahsulot turi, materiali, rangi, rasmdagi yozuvlar. " +
    "O'zbekcha (lotin) va ruscha variantlarini aralashtir, masalan: \"qor shari\", \"snejniy shar\", \"krujka\", \"soat\".",
  "- what: mahsulot nima ekanini o'zbekcha 3-6 so'z bilan.",
  "Faqat JSON qaytar.",
].join('\n');

const RANK_PROMPT = (n) =>
  [
    `Birinchi rasm — mijoz yuborgan mahsulot. Keyingi ${n} ta rasm — do'kon bazasidagi nomzodlar, har birining oldida raqami bor.`,
    "Qaysi nomzod AYNAN shu mahsulot (shakli, rangi, yozuvi, dizayni bir xil)? Har biriga 0-100 o'xshashlik bahosi ber.",
    'JSON qaytar: {"best": [{"n": raqam, "score": 0-100}]} — eng o\'xshashdan boshlab, ko\'pi bilan 3 ta, 30 dan past baholarni qo\'shma.',
    'Faqat JSON qaytar.',
  ].join('\n');

// The largest size of a Telegram photo (or an image document) as bytes.
async function telegramPhoto(msg) {
  const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document?.mime_type?.startsWith('image/') ? msg.document.file_id : null;
  if (!fileId) return null;
  const f = await tg('getFile', { file_id: fileId });
  return downloadImage(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${f.file_path}`);
}

async function byCodes(codes) {
  const found = new Map();
  for (const code of codes.map((c) => String(c).replace(/\D/g, '')).filter((c) => c.length >= 4).slice(0, 4)) {
    const exact = await findBySku(code, { fresh: true }).catch(() => null);
    if (exact && isTradable(exact)) found.set(String(exact._id), exact);
    if (!found.size) {
      // a barcode: BITO search covers barcodes
      const { list } = await getProductsPage({ page: 1, limit: 5, search: code }).catch(() => ({ list: [] }));
      for (const p of list.filter(isTradable)) found.set(String(p._id), p);
    }
    if (found.size) break;
  }
  return [...found.values()];
}

async function byWords(words) {
  const found = new Map();
  const terms = [...new Set(words.map((w) => String(w).trim()).filter((w) => w.length >= 3))].slice(0, 6);
  for (const term of terms) {
    const { list } = await getProductsPage({ page: 1, limit: 20, search: term }).catch(() => ({ list: [] }));
    for (const p of list.filter((x) => isTradable(x) && productImage(x))) found.set(String(p._id), p);
    if (found.size >= CANDIDATES * 2) break;
  }
  // also single words of longer phrases, when phrases found little
  if (found.size < 4) {
    for (const w of [...new Set(terms.flatMap((t) => t.split(/\s+/)).filter((w) => w.length >= 4))].slice(0, 6)) {
      const { list } = await getProductsPage({ page: 1, limit: 15, search: w }).catch(() => ({ list: [] }));
      for (const p of list.filter((x) => isTradable(x) && productImage(x))) found.set(String(p._id), p);
      if (found.size >= CANDIDATES) break;
    }
  }
  return [...found.values()].slice(0, CANDIDATES);
}

// Gemini compares the photo with the candidates' photos; returns [{ p, score }] best first.
async function rank(photo, candidates) {
  const imgs = await mapLimit(candidates, 4, async (p) => {
    try {
      return { p, part: await imagePart(imageUrl(productImage(p)), 256) };
    } catch {
      return null;
    }
  });
  const usable = imgs.filter(Boolean);
  if (!usable.length) return [];
  const parts = [{ text: RANK_PROMPT(usable.length) }, photo];
  usable.forEach((x, i) => parts.push({ text: `${i + 1}:` }, x.part));
  const ans = parseJson(await callGemini(parts, { json: true, temperature: 0.1 })) || {};
  return (Array.isArray(ans.best) ? ans.best : [])
    .map((b) => ({ p: usable[Number(b.n) - 1]?.p, score: Number(b.score) || 0 }))
    .filter((x) => x.p && x.score >= MIN_SCORE)
    .slice(0, SHOW);
}

const NAME_PROMPT = (q) =>
  [
    `Sovg'a / aksessuar do'koni bazasidan mahsulot qidirilmoqda. Mijoz yozdi: "${q}".`,
    "Bazadagi nomlar o'zbekcha (lotin), ruscha yoki aralash bo'lishi mumkin, xatolar bilan yozilgan bo'lishi mumkin.",
    'JSON qaytar: {"words": [...]} — qidirish uchun 3-6 ta qisqa so\'z yoki ibora: to\'g\'ri yozilishi, sinonimlar, o\'zbekcha va ruscha variantlari.',
    'Faqat JSON qaytar.',
  ].join('\n');

// By name: BITO's own search; nothing found -> Gemini turns the query into search words (spelling,
// synonyms, Uzbek / Russian) -> BITO again. Products with a photo first. { how: 'name' | 'ai' | 'none', results }
export async function findByName(query, { limit = 5 } = {}) {
  const q = String(query).trim();
  const { list } = await getProductsPage({ page: 1, limit: 20, search: q }).catch(() => ({ list: [] }));
  let found = list.filter(isTradable);
  let how = 'name';
  if (!found.length && aiConfigured()) {
    const ans = parseJson(await callGemini([{ text: NAME_PROMPT(q) }], { json: true, temperature: 0.1 }).catch(() => '{}')) || {};
    found = await byWords(Array.isArray(ans.words) ? ans.words : []);
    how = 'ai';
  }
  found.sort((a, b) => (String(b.sku) === q) - (String(a.sku) === q) || Boolean(productImage(b)) - Boolean(productImage(a)));
  return { how: found.length ? how : 'none', results: found.slice(0, limit), total: found.length };
}

// Staff (admin chat): a name -> up to 5 similar products with photo, name, SKU, price, stock.
export async function handleNameSearch(msg, s, query) {
  const chatId = msg.chat.id;
  const r = await findByName(query).catch((e) => {
    console.error(`name search failed: ${errText(e)}`);
    return { how: 'none', results: [] };
  });
  if (!r.results.length) return tg('sendMessage', { chat_id: chatId, text: `🔎 «${query}» bo'yicha hech narsa topilmadi. SKU, shtrix-kod yoki boshqacha yozib ko'ring.` });
  await tg('sendMessage', {
    chat_id: chatId,
    text: `🔎 «${query}»: ${r.how === 'ai' ? "aynan topilmadi, o'xshashlari" : 'topildi'} — ${r.results.length}${r.total > r.results.length ? ` / ${r.total}` : ''} ta:`,
  });
  const discounts = await loadDiscounts();
  for (const p of r.results) await staffCard(chatId, p, s, discounts, 0);
  return r.results.length;
}

// The search itself: { how: 'code' | 'look' | 'none', results: [{ p, score }], what, error }
export async function findByPhoto(bytes) {
  const photo = await imagePart(bytes, 768);
  const read = parseJson(await callGemini([{ text: READ_PROMPT }, photo], { json: true, temperature: 0.1 })) || {};
  const codes = Array.isArray(read.codes) ? read.codes : [];
  const words = Array.isArray(read.words) ? read.words : [];
  const exact = codes.length ? await byCodes(codes) : [];
  if (exact.length) return { how: 'code', results: exact.slice(0, SHOW).map((p) => ({ p, score: 100 })), what: read.what };
  const candidates = await byWords(words);
  if (!candidates.length) return { how: 'none', results: [], what: read.what, words };
  const ranked = await rank(photo, candidates).catch((e) => {
    console.error(`photo search: ranking failed: ${errText(e)}`);
    return null;
  });
  if (ranked === null) return { how: 'look', results: candidates.slice(0, SHOW).map((p) => ({ p, score: 0 })), what: read.what, unranked: true };
  return { how: ranked.length ? 'look' : 'none', results: ranked, what: read.what, words, candidates: candidates.length };
}

const level = (score) => (score >= 80 ? 'yuqori' : score >= 55 ? "o'rtacha" : 'past');

async function staffCard(chatId, p, s, discounts, score) {
  const pr = await priceFor(p, discounts).catch(() => ({ price: 0 }));
  const stock = productStock(p);
  const rec = stock <= 0 ? await getRecord(p._id).catch(() => null) : null;
  const lines = [
    `🛍 ${esc(p.name)}`,
    `🔢 SKU: <code>${esc(p.sku)}</code>`,
    `💰 Narxi: ${pr.price > 0 ? `${pr.old_price > pr.price ? `<s>${formatPrice(pr.old_price)}</s> → ` : ''}${formatPrice(pr.price)} so'm` : "yo'q"}`,
    `📦 Qoldiq: ${stock}${stock <= 0 && rec ? ` (tugagan: ${esc(outDateText(rec))})` : ''}`,
  ];
  if (score) lines.push(`🎯 O'xshashlik: ${level(score)} (${score}%)`);
  const caption = lines.join('\n');
  const img = imageUrl(productImage(p));
  if (img) {
    try {
      return await tg('sendPhoto', { chat_id: chatId, photo: img, caption, parse_mode: 'HTML' });
    } catch (e) {
      console.error(`photo search card ${p.sku}: ${errText(e)}`);
    }
  }
  return tg('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML' });
}

// From a message with a photo: progress, search, result cards. audience: 'staff' | 'customer'.
export async function handlePhotoSearch(msg, s, audience) {
  const chatId = msg.chat.id;
  const reply = (text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, ...(msg.message_id ? { reply_to_message_id: msg.message_id } : {}), ...extra }).catch(() => null);
  if (!photoSearchOn(s)) {
    return reply(audience === 'staff' ? "📷 Rasm bo'yicha qidiruv o'chiq (yoki GEMINI_API_KEY yo'q): Admin panel → 🤖 AI tavsif." : `Rasm bo'yicha qidiruv hozir ishlamayapti. Mahsulot nomini yozing yoki buyurtma uchun: ${s.phone}`);
  }
  if (audience === 'customer') {
    const used = Number(await db.redis().hincrby(db.K.stats(db.today()), `photo_search:${msg.from?.id}`, 1)) || 0;
    if (used > CUSTOMER_DAILY) return reply(`Bugungi rasm qidiruvlari limiti tugadi. Mahsulot nomini yozing yoki buyurtma uchun: ${s.phone}`);
  }
  const wait = await reply("🔎 Rasm bo'yicha qidiryapman... (30-60 soniya olishi mumkin)");
  const done = async () => wait?.message_id && tg('deleteMessage', { chat_id: chatId, message_id: wait.message_id }).catch(() => {});
  let r;
  try {
    const bytes = await telegramPhoto(msg);
    if (!bytes) {
      await done();
      return reply('📷 Rasm topilmadi — mahsulot rasmini yuboring.');
    }
    r = await findByPhoto(bytes);
  } catch (e) {
    console.error(`photo search failed: ${errText(e)}`);
    await done();
    await db.incrStat('photo_search_failed');
    return reply(
      audience === 'staff'
        ? `❌ Qidirib bo'lmadi: ${errText(e).slice(0, 200)}\nBirozdan keyin qayta urinib ko'ring yoki SKU / nomini yozing.`
        : `Hozir qidirib bo'lmadi, birozdan keyin qayta urinib ko'ring yoki mahsulot nomini yozing. Buyurtma uchun: ${s.phone}`,
    );
  }
  await done();
  await db.incrStat('photo_search');
  console.log(`photo search (${audience}): ${r.how}, ${r.results.length} found${r.what ? `, "${r.what}"` : ''}`);
  if (!r.results.length) {
    await db.incrStat('photo_search_none');
    return reply(
      `🔎 Rasm bo'yicha mos mahsulot topilmadi${r.what ? ` (${r.what})` : ''}.` +
        (audience === 'staff' && r.words?.length ? `\nQidirilgan so'zlar: ${r.words.join(', ')}` : '') +
        `\nMahsulot nomi yoki ${audience === 'staff' ? 'SKU / shtrix-kodini' : 'SKU sini'} yozib ko'ring.`,
    );
  }
  const head =
    r.how === 'code'
      ? "✅ Rasmdagi kod bo'yicha topildi:"
      : r.unranked
        ? `🔎 Taxminiy natijalar${r.what ? ` (${r.what})` : ''} — aniq solishtirib bo'lmadi:`
        : `🔎 Eng o'xshash${r.results.length > 1 ? ` ${r.results.length} ta` : ''}${r.what ? ` (${r.what})` : ''}:`;
  await reply(head);
  const discounts = await loadDiscounts();
  for (const { p, score } of r.results) {
    if (audience === 'staff') await staffCard(chatId, p, s, discounts, r.how === 'code' ? 0 : score);
    else await card(chatId, p, s, discounts);
  }
  return r.results.length;
}
