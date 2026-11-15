// "🤖 AI avto-javob": mijoz savollariga (narx, bor-yo'qligi, manzil, ish vaqti, yetkazib berish) javob.
// Qoidalar:
//  - narx va qoldiq FAQAT BITO'dan olinadi, AI ularni o'zi o'ylab topmaydi;
//  - javobdagi raqam kontekstda bo'lmasa, javob yuborilmaydi (mijozga telefon beriladi);
//  - mijozning telefon raqami / @username'i AI'ga yuborilmaydi;
//  - do'kon mavzusidan tashqari savolga javob berilmaydi.
// Sozlama: s.ai_chat = { on, business, info }. Admin: /avtojavob.
import { formatPrice, getProductsPage, loadDiscounts, priceFor, productStock } from './bito.js';
import { callGemini, aiConfigured } from './ai.js';
import { loadAiKeys } from './aikeys.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';
import { webhookSecretToken } from './webhook-secret.js';

const DAILY_CAP = 20; // bir mijozga kuniga ko'pi bilan shuncha AI javobi
const PAUSE_MIN = 60; // egasi o'zi yozsa, bot shu chatda shuncha daqiqa jim turadi
const MAX_QUESTION = 400;

export const DEFAULT_INFO = "Manzil: Toshkent, Хамкор ko'chasi, 30A. Ish vaqti: soat 9:00 dan ochiladi.";
export const chatCfg = (s) => ({ on: false, business: false, info: '', ...(s?.ai_chat || {}) });
export const chatAiOn = (s) => aiConfigured() && chatCfg(s).on === true;

// shaxsiy ma'lumotni olib tashlash: telefon raqamlari, @username, havolalar
export function scrub(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@\w{3,}/g, ' ')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUESTION);
}

// raqam guruhlari: "150 000" bitta son, "9:00" — "9" va "00"
const numTokens = (t) => {
  const out = new Set();
  for (const m of String(t).match(/\d{1,2}:\d{2}|\d+(?:[ \u00a0]\d{3})*/g) || []) {
    if (m.includes(':')) {
      out.add(m);
      continue;
    }
    out.add(m.replace(/\D/g, ''));
    for (const part of m.split(/[ \u00a0]/)) out.add(part);
  }
  return out;
};
// javobdagi har bir 2+ xonali raqam kontekstda bo'lishi shart
export function numbersAllowed(reply, context) {
  const allowed = numTokens(context);
  return [...numTokens(reply)].every((n) => n.length < 2 || allowed.has(n));
}

async function productFacts(question) {
  const { list } = await getProductsPage({ page: 1, limit: 20, search: question }).catch(() => ({ list: [] }));
  const found = list.filter((p) => p.name).slice(0, 3);
  if (!found.length) return '';
  const discounts = await loadDiscounts().catch(() => null);
  const lines = [];
  for (const p of found) {
    const pr = await priceFor(p, discounts).catch(() => ({ price: 0 }));
    const stock = productStock(p);
    lines.push(`- ${p.name}: ${pr.price > 0 ? `${formatPrice(pr.price)} so'm` : 'narxi operatorda'}; ${stock > 0 ? 'sotuvda bor' : 'hozir tugagan'}`);
  }
  return lines.join('\n');
}

async function underCap(user) {
  if (!db.hasRedis()) return true;
  const key = db.K.flag(`chatai:n:${user}:${new Date().toISOString().slice(0, 10)}`);
  const n = Number(await db.redis().get(key)) || 0;
  if (n >= DAILY_CAP) return false;
  await db.redis().set(key, n + 1, { ex: 86400 }).catch(() => {});
  return true;
}

// Matn javob yoki null (null — AI ishlatilmadi / ishonchsiz: chaqiruvchi oddiy javobni beradi).
export async function aiReply(text, s, user = 'anon') {
  await loadAiKeys().catch(() => {});
  if (!chatAiOn(s)) return null;
  const q = scrub(text);
  if (q.length < 3 || !(await underCap(user))) return null;
  try {
    const facts = await productFacts(q);
    const info = chatCfg(s).info || DEFAULT_INFO;
    const context = `${info}\nTelefon: ${s.phone}\nBuyurtma: ${s.order_url}\n${facts}`;
    const prompt = [
      "Sen Mixpodarok sovg'a do'konining yordamchisisan. Mijozga o'zbek tilida (mijoz rus tilida yozsa — rus tilida), qisqa va xushmuomala javob ber (2–4 gap).",
      "QOIDALAR:",
      "1) Faqat quyidagi MA'LUMOT asosida javob ber. Narx, qoldiq, manzil, vaqt, yetkazib berish haqida MA'LUMOTda yo'q narsani o'ylab topma.",
      "2) MA'LUMOTda javob yo'q bo'lsa yoki savol do'kondan tashqarida bo'lsa, javob berma: \"Bu savol bo'yicha operatorimiz yordam beradi\" deb telefonni ayt.",
      "3) Raqamlarni faqat MA'LUMOTdan aynan ko'chir.",
      "4) Buyurtma berish uchun havola yoki telefonni taklif qil.",
      "",
      `MA'LUMOT:\n${context}`,
      "",
      `MIJOZ SAVOLI: ${q}`,
      "JAVOB:",
    ].join('\n');
    const out = String(await callGemini([{ text: prompt }], { temperature: 0.3 })).trim().slice(0, 900);
    if (!out || !numbersAllowed(out, context)) {
      console.log('chatai: javob raqam tekshiruvidan o\'tmadi, yuborilmadi');
      return null;
    }
    return out;
  } catch (e) {
    console.error(`chatai: ${errText(e)}`);
    return null;
  }
}

// Telegram Business chatlari (egasining akkauntiga yozgan mijozlar)
export async function handleBusinessMessage(msg) {
  const s = await db.getSettings();
  const cfg = chatCfg(s);
  await loadAiKeys().catch(() => {});
  if (!chatAiOn(s) || cfg.business !== true) return null;
  const connId = msg.business_connection_id;
  const chatId = msg.chat?.id;
  if (!connId || !chatId || !msg.text) return null;
  const pauseKey = `chatai:pause:${connId}:${chatId}`;
  const biz = (await db.listBiz()).find((b) => b.id === connId);
  // egasi (yoki xodim) o'zi yozdi: bot shu chatda PAUSE_MIN daqiqa jim
  if (biz?.user && String(msg.from?.id) === String(biz.user.id)) {
    await db.redis().set(db.K.flag(pauseKey), 1, { ex: PAUSE_MIN * 60 }).catch(() => {});
    return null;
  }
  if (await db.redis().get(db.K.flag(pauseKey)).catch(() => null)) return null;
  if (biz && biz.is_enabled === false) return null;
  const reply = await aiReply(msg.text, s, `biz:${chatId}`);
  if (!reply) return null;
  return tg('sendMessage', { business_connection_id: connId, chat_id: chatId, text: reply }).catch((e) =>
    console.error(`chatai business send: ${errText(e)}`),
  );
}

// Dashboard ("💬 Avto-javob" tab)
export function chatView(s) {
  return { ...chatCfg(s), default_info: DEFAULT_INFO, ai: aiConfigured() };
}
export async function chatSetCfg(body = {}) {
  const cur = chatCfg(await db.getSettings());
  const next = {
    on: 'on' in body ? Boolean(body.on) : cur.on,
    business: 'business' in body ? Boolean(body.business) : cur.business,
    info: body.info == null ? cur.info : String(body.info).trim().slice(0, 1500),
  };
  await db.updateSettings({ ai_chat: next });
  await loadAiKeys().catch(() => {});
  const warn = next.on && !aiConfigured() ? " ⚠️ AI kaliti yo'q (GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY)" : '';
  return { ok: true, message: `💾 Saqlandi${next.on ? '' : " (o'chiq)"}${warn}`, cfg: chatView({ ai_chat: next }) };
}

// Admin: /avtojavob [on|off|biz on|biz off|info <matn>|info reset]
export async function handleChatAiCommand(chatId, args, s) {
  const cfg = chatCfg(s);
  const [a, b, ...rest] = String(args || '').trim().split(/\s+/);
  let patch = null;
  if (a === 'on' || a === 'off') patch = { ...cfg, on: a === 'on' };
  else if (a === 'biz' && (b === 'on' || b === 'off')) patch = { ...cfg, business: b === 'on' };
  else if (a === 'info') patch = { ...cfg, info: b === 'reset' ? '' : [b, ...rest].filter(Boolean).join(' ').slice(0, 1500) };
  if (patch) {
    await db.updateSettings({ ai_chat: patch });
    s = await db.getSettings();
  }
  const c = chatCfg(s);
  const text = [
    `🤖 AI avto-javob: ${c.on ? '✅ yoqilgan' : '⛔ o\'chiq'}`,
    `💼 Telegram Business chatlari: ${c.business ? '✅' : '⛔'}`,
    `AI kaliti: ${aiConfigured() ? '✅' : '❌ yo\'q'}`,
    `ℹ️ Do'kon ma'lumoti:\n${c.info || DEFAULT_INFO}`,
    '',
    "/avtojavob on | off\n/avtojavob biz on | off\n/avtojavob info <ish vaqti, yetkazib berish, to'lov matni>\n/avtojavob info reset",
  ].join('\n');
  return tg('sendMessage', { chat_id: chatId, text });
}

// Admin: /webhook — joriy webhook manzili o'zgarmaydi, faqat allowed_updates'ga business_message qo'shiladi.
export async function handleWebhookRefresh(chatId) {
  try {
    const cur = await tg('getWebhookInfo');
    if (!cur.url) return tg('sendMessage', { chat_id: chatId, text: "⚠️ Webhook o'rnatilmagan. /api/setup-webhook ni chaqiring." });
    await tg('setWebhook', {
      url: cur.url,
      secret_token: webhookSecretToken(),
      allowed_updates: ['message', 'callback_query', 'business_connection', 'business_message', 'my_chat_member'],
    });
    const info = await tg('getWebhookInfo');
    return tg('sendMessage', { chat_id: chatId, text: `✅ Webhook yangilandi.\n${info.url}\nXabar turlari: ${(info.allowed_updates || []).join(', ')}` });
  } catch (e) {
    return tg('sendMessage', { chat_id: chatId, text: `❌ Webhook yangilanmadi: ${errText(e)}` }).catch(() => {});
  }
}
