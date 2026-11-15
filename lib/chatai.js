// "🤖 AI avto-javob": mijoz savollariga (narx, bor-yo'qligi, manzil, ish vaqti, yetkazib berish) javob.
// Qoidalar:
//  - narx va qoldiq FAQAT BITO'dan olinadi, AI ularni o'zi o'ylab topmaydi;
//  - javobdagi raqam kontekstda bo'lmasa, javob yuborilmaydi (mijozga telefon beriladi);
//  - mijozning telefon raqami / @username'i AI'ga yuborilmaydi;
//  - do'kon mavzusidan tashqari savolga javob berilmaydi.
// Sozlama: s.ai_chat = { on, business, info }. Admin: /avtojavob.
import { productFacts } from './chatbito.js';
import { buildPostCaption } from './caption.js';
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
export const chatCfg = (s) => ({ on: false, business: false, info: '', rules: '', profiles: {}, ...(s?.ai_chat || {}) });
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

// raqam guruhlari: "150 000" bitta son; "9:00" = "09:00"; telefon (9+ raqam) bo'shliq/tire farqisiz
const numTokens = (t) => {
  const out = new Set();
  let rest = String(t).replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => {
    const d = m.replace(/\D/g, '');
    if (d.length < 9) return m;
    out.add(`tel:${d.slice(-9)}`);
    return ' ';
  });
  rest = rest.replace(/(\d{1,2}):(\d{2})/g, (_, h, mm) => {
    out.add(`${Number(h)}:${mm}`);
    return ' ';
  });
  for (const m of rest.match(/\d+(?:[ \u00a0]\d{3})*/g) || []) {
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

async function underCap(user) {
  if (!db.hasRedis()) return true;
  const key = db.K.flag(`chatai:n:${user}:${new Date().toISOString().slice(0, 10)}`);
  const n = Number(await db.redis().get(key)) || 0;
  if (n >= DAILY_CAP) return false;
  await db.redis().set(key, n + 1, { ex: 86400 }).catch(() => {});
  return true;
}

// Matn javob yoki null (null — AI ishlatilmadi / ishonchsiz: chaqiruvchi oddiy javobni beradi).
// over — Business profil sozlamasi { info, rules, bito }: shu profilning o'z matni; ma'lumot bo'sh bo'lsa javob berilmaydi
export async function aiReply(text, s, user = 'anon', over = null, meta = null) {
  await loadAiKeys().catch(() => {});
  if (over ? !aiConfigured() || !String(over.info || '').trim() : !chatAiOn(s)) return null;
  const q = scrub(text);
  if (q.length < 3 || !(await underCap(user))) return null;
  try {
    const useBito = over ? over.bito === true : true;
    const facts = useBito ? await productFacts(q, meta) : '';
    const info = over ? String(over.info).trim() : chatCfg(s).info || DEFAULT_INFO;
    const rules = over ? String(over.rules || '').trim() : chatCfg(s).rules;
    const context = over ? `${info}\n${facts}` : `${info}\nTelefon: ${s.phone}\nBuyurtma: ${s.order_url}\n${facts}`;
    const prompt = [
      `Sen ${over ? 'MA\'LUMOTda tasvirlangan biznesning' : "Mixpodarok sovg'a do'konining"} yordamchisisan. Mijozga o'zbek tilida (mijoz rus tilida yozsa — rus tilida), qisqa va xushmuomala javob ber (2–4 gap).`,
      "QOIDALAR:",
      "1) Faqat quyidagi MA'LUMOT asosida javob ber. Narx, qoldiq, manzil, vaqt, yetkazib berish haqida MA'LUMOTda yo'q narsani o'ylab topma.",
      "2) MA'LUMOTda javob yo'q bo'lsa yoki savol do'kondan tashqarida bo'lsa, javob berma: \"Bu savol bo'yicha operatorimiz yordam beradi\" deb telefonni ayt.",
      "3) Raqamlarni faqat MA'LUMOTdan aynan ko'chir.",
      "4) Buyurtma berish uchun MA'LUMOTdagi telefon yoki havolani taklif qil.",
      ...(rules ? ['', "EGASINING QO'SHIMCHA QOIDALARI (yuqoridagilarga zid kelmasa, bajar):", rules] : []),
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
  if (cfg.business !== true || !aiConfigured()) return null;
  const connId = msg.business_connection_id;
  const chatId = msg.chat?.id;
  if (!connId || !chatId || !msg.text) return null;
  const pauseKey = `chatai:p2:${connId}:${chatId}`;
  const biz = (await db.listBiz()).find((b) => b.id === connId);
  // egasi (yoki xodim) o'zi yozdi: bot shu chatda PAUSE_MIN daqiqa jim
  if (biz?.user && String(msg.from?.id) === String(biz.user.id)) {
    // avtomatik xabarlar (Telegram salomlashish / "yo'qligim" xabari, botning o'z javobi) egasi yozgan hisoblanmaydi
    if (msg.is_from_offline || msg.sender_business_bot) return null;
    await db.redis().set(db.K.flag(pauseKey), 1, { ex: PAUSE_MIN * 60 }).catch(() => {});
    return null;
  }
  if (await db.redis().get(db.K.flag(pauseKey)).catch(() => null)) return null;
  if (biz && biz.is_enabled === false) return null;
  // har bir Business profilning o'z yoqilishi va matni bor
  const prof = cfg.profiles?.[connId];
  if (!prof?.on) return null;
  const meta = {};
  const reply = await aiReply(msg.text, s, `biz:${connId}:${chatId}`, prof, meta);
  if (!reply) return null;
  const sent = await tg('sendMessage', { business_connection_id: connId, chat_id: chatId, text: reply }).catch((e) =>
    console.error(`chatai business send: ${errText(e)}`),
  );
  // topilgan mahsulotlar (eng ko'pi bilan 3) — kanal posti ko'rinishida, SKU bilan, har biri alohida
  if (/\d/.test(reply)) {
    for (const it of (meta.items || []).filter((i) => i.ok)) {
      const cap = `${buildPostCaption(it, null, { desc: false })}\n🔖 SKU: ${it.sku}${it.stock > 0 ? '' : '\n❌ Hozir tugagan'}`;
      const base = { business_connection_id: connId, chat_id: chatId, parse_mode: 'HTML' };
      await (it.image_url
        ? tg('sendPhoto', { ...base, photo: it.image_url, caption: cap })
        : tg('sendMessage', { ...base, text: cap })
      ).catch((e) => console.error(`chatai business card: ${errText(e)}`));
    }
  }
  return sent;
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
    rules: body.rules == null ? cur.rules : String(body.rules).trim().slice(0, 1500),
  };
  await db.updateSettings({ ai_chat: next });
  await loadAiKeys().catch(() => {});
  const warn = next.on && !aiConfigured() ? " ⚠️ AI kaliti yo'q (GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY)" : '';
  return { ok: true, message: `💾 Saqlandi${next.on ? '' : " (o'chiq)"}${warn}`, cfg: chatView({ ai_chat: next }) };
}

// Business profillari (har birining o'z sozlamasi)
export async function chatProfilesView(s) {
  const cfg = chatCfg(s);
  return (await db.listBiz().catch(() => [])).map((b) => {
    const p = cfg.profiles?.[b.id] || {};
    return {
      id: b.id,
      label: db.bizLabel(b),
      connected: b.is_enabled !== false,
      can_reply: b.rights?.can_reply === true,
      on: p.on === true,
      bito: p.bito === true,
      info: p.info || '',
      rules: p.rules || '',
    };
  });
}
export async function chatSetProfile(body = {}) {
  const id = String(body.id || '');
  const biz = (await db.listBiz()).find((b) => b.id === id);
  if (!biz) return { ok: false, message: '❌ Profil topilmadi' };
  const cfg = chatCfg(await db.getSettings());
  const cur = cfg.profiles?.[id] || {};
  const txt = (v, d) => (v == null ? d : String(v).trim().slice(0, 1500));
  const next = { on: 'on' in body ? Boolean(body.on) : cur.on === true, bito: 'bito' in body ? Boolean(body.bito) : cur.bito === true, info: txt(body.info, cur.info || ''), rules: txt(body.rules, cur.rules || '') };
  await db.updateSettings({ ai_chat: { ...cfg, profiles: { ...(cfg.profiles || {}), [id]: next } } });
  const warns = [];
  if (next.on && !next.info) warns.push("do'kon ma'lumoti bo'sh — bot javob bermaydi");
  if (next.on && !biz.rights?.can_reply) warns.push("botga «javob yozish» huquqi berilmagan");
  return { ok: true, message: `💾 ${db.bizLabel(biz)} saqlandi${next.on ? '' : " (o'chiq)"}${warns.length ? ' ⚠️ ' + warns.join('; ') : ''}` };
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
  const biz = await db.listBiz().catch(() => []);
  const bizLines = biz.length
    ? biz.map((b) => {
        const r = b.rights || {};
        const on = Object.keys(r).filter((k) => r[k] === true).join(', ') || "yo'q";
        return `• ${db.bizLabel(b)}: ${b.is_enabled ? 'ulangan' : 'uzilgan'}; javob yozish (can_reply): ${r.can_reply ? '✅' : '❌'}; yoqilgan huquqlar: ${on}`;
      })
    : ["• Business profil ulanmagan"];
  const text = [
    `🤖 AI avto-javob: ${c.on ? '✅ yoqilgan' : '⛔ o\'chiq'}`,
    `💼 Telegram Business chatlari: ${c.business ? '✅' : '⛔'}`,
    `AI kaliti: ${aiConfigured() ? '✅' : '❌ yo\'q'}`,
    ...bizLines,
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
