// "🤖 AI yordamchi" (owner only): the admin writes in plain words, Gemini answers with the bot's real
// data (function calling) and prepares actions. Three jobs:
//   - admin helper: "bugun nechta post chiqdi?", "2754 ni kanalga va istoriyaga qo'y", "istoriyani 48 soat qil"
//   - post writer: product descriptions, holiday / collection posts
//   - sales analyst: on request, and every evening (after 21:00 Tashkent) a short summary to the admins
// Anything that changes something (posting, settings, saving a description) is never done by the model
// itself: it becomes a "✅ Bajarish / ❌ Bekor" card and runs only after the owner presses ✅.

import { randomBytes } from 'node:crypto';
import { aiConfigured, aiModel, generateDesc, setDesc } from './ai.js';
import { findBySku, formatPrice, loadDiscounts, priceFor, productImage, productStock, toItem } from './bito.js';
import { collectDashboard } from './dashboard.js';
import { findByName } from './photosearch.js';
import { postItemsNow, postStoriesNow } from './poster.js';
import { notifyAdmins } from './report.js';
import { postSales } from './postsales.js';
import { buildDayReport } from './dayreport.js';
import { reorderLines, reorderList, salesByItem, slowLines, slowMovers } from './sales.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText, fetchWithTimeout } from './util.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const HIST = (uid) => `${db.K.flag('agent')}:hist:${uid}`;
const ACT = (id) => `${db.K.flag('agent')}:act:${id}`;
const MAX_TURNS = 12; // remembered messages (user + assistant)
const MAX_STEPS = 6; // model <-> tools rounds per question
const DAILY_HOUR = 21;

export const agentReady = () => aiConfigured();
export const agentDailyOn = (s) => s.agent_daily !== false;

const strip = (t) => String(t ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tashkentHour = (ms = Date.now()) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date(ms))) % 24;

// ---- tools: reading ----

async function productInfo(p, discounts) {
  const pr = await priceFor(p, discounts).catch(() => null);
  return {
    sku: String(p.sku),
    name: p.name,
    price: pr?.price > 0 ? formatPrice(pr.price) : null,
    old_price: pr?.old_price > pr?.price ? formatPrice(pr.old_price) : null,
    stock: productStock(p),
    has_photo: Boolean(productImage(p)),
  };
}

const READ = {
  async dashboard_summary() {
    const d = await collectDashboard();
    return {
      today: d.today,
      today_stats: d.today_stats,
      last_7_days: d.days.slice(-7),
      queues: { channel: d.queues.channel, story: d.queues.story && { total: d.queues.story.total, per_day: d.queues.story.per_day, ends: d.queues.story.eta }, restock: d.queues.restock, ch2: d.queues.ch2 },
      health: d.health,
      story_profiles: d.profiles.map((p) => ({ profile: p.label, today: p.stories, limit: p.limit, last_ok: p.last?.ok ?? null, last_error: p.last?.error || null })),
      settings: { toggles: d.settings.toggles, story_pace: d.settings.pace, channels: d.settings.channels, channel2: d.settings.channel2, phone: d.settings.phone },
      shop: d.extras,
      last_errors: d.errors.slice(0, 5).map((e) => e.text),
    };
  },
  async sales({ days = 7 } = {}) {
    const n = Math.min(30, Math.max(1, Math.round(Number(days) || 7)));
    const r = await salesByItem(n);
    const rows = [...(r?.rows || [])].sort((a, b) => b.sold - a.sold);
    return {
      days: n,
      total_sum: formatPrice(r?.total?.net || 0),
      total_items: r?.total?.sold || 0,
      top: rows.slice(0, 15).map((x) => ({ name: x.name, sold: x.sold, sum: formatPrice(x.net), category: x.category || null })),
    };
  },
  async reorder() {
    const s = await db.getSettings();
    return { lines: [].concat(reorderLines(await reorderList(s)) || []).map(strip).slice(0, 40) };
  },
  async slow_movers() {
    const s = await db.getSettings();
    return { lines: [].concat(slowLines(await slowMovers(s)) || []).map(strip).slice(0, 40) };
  },
  async find_product({ query } = {}) {
    const q = String(query || '').trim();
    if (!q) return { found: [] };
    const discounts = await loadDiscounts().catch(() => undefined);
    if (/^\d[\d-]*$/.test(q)) {
      const p = await findBySku(q, { fresh: true });
      return { found: p ? [await productInfo(p, discounts)] : [] };
    }
    const r = await findByName(q, { limit: 5 });
    return { found: await Promise.all((r?.results || []).map((p) => productInfo(p, discounts))) };
  },
  async day_report({ day } = {}) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : db.today();
    return { report: strip(await buildDayReport(d)) };
  },
  async post_sales({ days = 7 } = {}) {
    return postSales({ days });
  },
  async write_description({ sku } = {}) {
    const p = await findBySku(String(sku || ''), { fresh: true });
    if (!p) return { error: `SKU ${sku} topilmadi` };
    const text = await generateDesc(toItem(p, 0));
    return { sku: String(p.sku), name: p.name, description: text, note: "Saqlash uchun save_description chaqiring" };
  },
};

// ---- tools: actions (only after the owner's ✅) ----

const SETTINGS = {
  new_channel: 'bool', new_story: 'bool', discount_channel: 'bool', discount_story: 'bool', random_album: 'bool',
  random_story: 'bool', restock_post: 'bool', ai_desc: 'bool', pace_on: 'bool', agent_daily: 'bool',
  story_hours: 'hours', pace_from: 'time', pace_to: 'time', pace_every: 'minutes',
};
const SETTING_LABEL = {
  new_channel: '🆕 → kanal', new_story: '🆕 → istoriya', discount_channel: '🔥 → kanal', discount_story: '🔥 → istoriya',
  random_album: '🎲 Random 16:00', random_story: '🎲 → istoriya', restock_post: '🔄 Qayta keldi', ai_desc: '🤖 AI tavsif',
  pace_on: '📋 Istoriya navbati', agent_daily: '📈 Kunlik AI tahlil', story_hours: '⏳ Istoriya muddati',
  pace_from: '🕘 Istoriya boshlanishi', pace_to: '🕚 Istoriya tugashi', pace_every: '⏱ Istoriya oralig\'i',
};

function settingPatch(name, value) {
  const kind = SETTINGS[name];
  if (!kind) throw new Error(`Bu sozlamani o'zgartirib bo'lmaydi: ${name}`);
  const v = String(value).trim().toLowerCase();
  if (kind === 'bool') {
    if (/^(true|on|1|ha|yoq|yoqish|✅)$/.test(v)) return { [name]: true };
    if (/^(false|off|0|yo'q|yoq'|o'chir|o'chirish|❌)$/.test(v)) return { [name]: false };
    throw new Error(`${name}: ha/yo'q bo'lishi kerak`);
  }
  if (kind === 'hours') {
    const h = Number(v.replace(/\D/g, ''));
    if (h !== 24 && h !== 48) throw new Error('Istoriya muddati faqat 24 yoki 48 soat');
    return { story_period: h * 3600 };
  }
  if (kind === 'time') {
    const m = v.match(/^(\d{1,2})[:.](\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Vaqt HH:MM bo\'lishi kerak');
    return { [name]: `${m[1].padStart(2, '0')}:${m[2]}` };
  }
  const n = Math.round(Number(v.replace(/[^\d]/g, '')));
  const l = db.LIMITS.pace_every;
  if (!(n >= l.min && n <= l.max)) throw new Error(`Oraliq ${l.min}–${l.max} daqiqa bo'lishi kerak`);
  return { pace_every: n };
}

function describeAction(a) {
  const x = a.args || {};
  if (a.name === 'post_products') {
    const to = [].concat(x.targets || ['channel']).map((t) => (t === 'story' ? 'istoriya' : 'kanal')).join(' + ');
    return `📤 SKU ${[].concat(x.skus || []).join(', ')} → ${to}`;
  }
  if (a.name === 'set_setting') return `⚙️ ${SETTING_LABEL[x.name] || x.name}: ${x.value}`;
  if (a.name === 'save_description') return `📝 SKU ${x.sku} tavsifini saqlash:\n«${String(x.text || '').slice(0, 300)}»`;
  if (a.name === 'post_text') return `📢 Kanalga matnli post:\n«${String(x.text || '').slice(0, 600)}»`;
  return a.name;
}

async function runAction(a) {
  const s = await db.getSettings();
  const x = a.args || {};
  if (a.name === 'set_setting') {
    const patch = settingPatch(x.name, x.value);
    await db.updateSettings(patch);
    return `✅ Saqlandi: ${SETTING_LABEL[x.name] || x.name} → ${x.value}`;
  }
  if (a.name === 'save_description') {
    const p = await findBySku(String(x.sku || ''), { fresh: true });
    if (!p) throw new Error(`SKU ${x.sku} topilmadi`);
    await setDesc(toItem(p, 0), String(x.text || ''), 'admin');
    return `✅ SKU ${p.sku} tavsifi saqlandi — keyingi postlarda chiqadi.`;
  }
  if (a.name === 'post_text') {
    const text = String(x.text || '').trim();
    if (!text) throw new Error("Matn bo'sh");
    const channels = (s.channels || []).filter((c) => c.active);
    if (!channels.length) throw new Error("Faol kanal yo'q");
    const done = [];
    for (const c of channels) {
      await tg('sendMessage', { chat_id: c.id, text: text.slice(0, 4000) });
      done.push(c.title || c.id);
    }
    return `✅ Post joylandi: ${done.join(', ')}`;
  }
  if (a.name === 'post_products') {
    const skus = [...new Set([].concat(x.skus || []).map((v) => String(v).trim()).filter(Boolean))].slice(0, 10);
    const targets = new Set([].concat(x.targets || ['channel']));
    const discounts = await loadDiscounts().catch(() => undefined);
    const items = [];
    const notes = [];
    for (const sku of skus) {
      const p = await findBySku(sku, { fresh: true }).catch(() => null);
      if (!p) { notes.push(`${sku}: topilmadi`); continue; }
      if (!productImage(p)) { notes.push(`${sku}: rasmsiz`); continue; }
      const pr = await priceFor(p, discounts);
      if (!(pr.price > 0)) { notes.push(`${sku}: narxsiz`); continue; }
      items.push(toItem(p, pr, 'new', { force: true }));
    }
    if (!items.length) throw new Error(notes.join(', ') || 'Mahsulot topilmadi');
    const deadline = Date.now() + 200000;
    const lines = [];
    if (targets.has('channel')) {
      const r = await postItemsNow(items, s, { deadline });
      const n = Array.isArray(r?.posted) ? r.posted.length : Number(r?.posted) || 0;
      lines.push(`📢 Kanal: ${n}/${items.length}${r?.errors?.length ? ` — ${r.errors[0]}` : ''}`);
    }
    if (targets.has('story')) {
      const r = await postStoriesNow(items, s, { deadline, notify: false });
      lines.push(`📸 Istoriya: ${Number(r?.posted) || 0} ta${r?.queued ? `, navbatda ${r.queued}` : ''}`);
    }
    return [...lines, ...notes].join('\n');
  }
  throw new Error(`Noma'lum amal: ${a.name}`);
}

// ---- Gemini ----

const T = (name, description, properties = {}, required = []) => ({
  name,
  description,
  parameters: { type: 'OBJECT', properties, ...(required.length ? { required } : {}) },
});
const STR = (description) => ({ type: 'STRING', description });

const DECLARATIONS = [
  T('dashboard_summary', "Botning bugungi va oxirgi 7 kunlik holati: postlar, istoriyalar, navbatlar, profillar, sozlamalar, xatolar, do'kon raqamlari."),
  T('sales', "BITO savdosi: oxirgi N kunda jami summa va eng ko'p sotilgan mahsulotlar.", { days: { type: 'NUMBER', description: '1–30, masalan 1 (bugun), 7 (hafta), 30 (oy)' } }),
  T('reorder', "Qoldig'i tez tugaydigan, buyurtma qilish kerak bo'lgan mahsulotlar ro'yxati."),
  T('slow_movers', "Uzoq vaqt sotilmayotgan mahsulotlar ro'yxati."),
  T('find_product', "BITO'dan mahsulot qidirish (SKU raqami yoki nomi bo'yicha): narx, qoldiq, rasm bor-yo'qligi.", { query: STR('SKU yoki mahsulot nomi') }, ['query']),
  T('day_report', "Bir kunlik savdo hisoboti: sotuv, qaytarish, chegirma, tannarx, foyda, marja, eng ko'p sotilganlar, kategoriyalar. Tannarxi kiritilmagan mahsulotlar haqida ogohlantirish ham bor.", { day: STR('YYYY-MM-DD, bo\'sh = bugun') }),
  T('post_sales', "Post → sotuv: oxirgi N kunda kanalga chiqqan mahsulotlardan qanchasi sotilgani, post turlari bo'yicha (yangi, chegirma, qayta keldi, 2-kanal, random). Qaysi postlar sotuv olib kelishini bilish uchun.", { days: { type: 'NUMBER', description: '1–30' } }),
  T('write_description', 'Mahsulot uchun AI tavsif yozib beradi (hali saqlamaydi).', { sku: STR('SKU') }, ['sku']),
  T('post_products', 'Mahsulot(lar)ni hozir kanalga va/yoki istoriyaga joylash. Admin tasdiqlagandan keyin bajariladi.', {
    skus: { type: 'ARRAY', items: { type: 'STRING' }, description: "SKU'lar (10 tagacha)" },
    targets: { type: 'ARRAY', items: { type: 'STRING', enum: ['channel', 'story'] }, description: 'channel, story yoki ikkalasi' },
  }, ['skus', 'targets']),
  T('set_setting', `Bot sozlamasini o'zgartirish (tasdiqdan keyin). name: ${Object.keys(SETTINGS).join(', ')}. bool uchun value: true/false; story_hours: 24 yoki 48; pace_from/pace_to: HH:MM; pace_every: daqiqa.`, {
    name: { type: 'STRING', enum: Object.keys(SETTINGS) },
    value: STR('yangi qiymat'),
  }, ['name', 'value']),
  T('save_description', 'Mahsulot tavsifini saqlash (tasdiqdan keyin) — keyingi postlarda chiqadi.', { sku: STR('SKU'), text: STR('tavsif matni, 1–2 gap') }, ['sku', 'text']),
  T('post_text', 'Kanalga rasmsiz matnli post joylash (bayram tabrigi, aksiya e\'loni). Tasdiqdan keyin.', { text: STR('post matni') }, ['text']),
];
const ACTIONS = new Set(['post_products', 'set_setting', 'save_description', 'post_text']);

function systemPrompt(s) {
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Tashkent', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  return [
    "Sen Mixpodarok sovg'a do'konining Telegram boti (@MixPost_robot) uchun AI yordamchisan. Faqat do'kon egasi (admin) bilan gaplashasan.",
    "Doim o'zbek tilida (lotin), qisqa va aniq javob ber. Raqam va faktlarni faqat asboblardan (tools) ol — hech qachon o'ylab topma.",
    "Uch vazifang bor: 1) admin yordamchisi — bot holati, navbatlar, postlar, sozlamalar; 2) post yozuvchi — mahsulot tavsiflari, bayram va to'plam postlari (iliq, emoji me'yorida, narx va telefon bilan); 3) savdo tahlilchisi — nima yaxshi sotilyapti, nimani buyurtma qilish kerak, nimani reklama qilish kerak.",
    "Biror narsani o'zgartiradigan amal kerak bo'lsa (post joylash, sozlama, tavsif saqlash, matnli post) tegishli asbobni chaqir — tizim adminga tasdiq tugmasini ko'rsatadi. 'Bajardim' dema, 'tasdiqlasangiz bajaraman' de.",
    'Javobda HTML yoki markdown belgilarisiz oddiy matn yoz, kerak bo\'lsa qatorlarga ajrat va emoji ishlat.',
    `Bugun: ${today} (Toshkent). Do'kon telefoni: ${s.phone || '—'}.`,
  ].join('\n');
}

async function gemini(contents, s, { tools = true, temperature = 0.4 } = {}) {
  const model = await aiModel();
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(s) }] },
    contents,
    ...(tools ? { tools: [{ functionDeclarations: DECLARATIONS }] } : {}),
    generationConfig: { temperature, maxOutputTokens: 2048 },
  };
  for (let attempt = 0; ; attempt++) {
    const r = await fetchWithTimeout(
      `${API}/${encodeURIComponent(model)}:generateContent`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(body) },
      60000,
    );
    const data = await r.json().catch(() => ({}));
    if (r.ok) return data?.candidates?.[0]?.content || { role: 'model', parts: [] };
    if ((r.status === 429 || r.status >= 500) && attempt < 2) {
      await new Promise((ok) => setTimeout(ok, 3000 * (attempt + 1)));
      continue;
    }
    throw new Error(`Gemini ${r.status}: ${data?.error?.message || 'xato'}`.slice(0, 300));
  }
}

// One question: model <-> read tools until it answers; action calls become pending cards.
async function think(uid, text, s) {
  const hist = ((await db.redis().get(HIST(uid)).catch(() => null)) || []).slice(-MAX_TURNS);
  const contents = [...hist, { role: 'user', parts: [{ text }] }];
  const actions = [];
  let answer = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const content = await gemini(contents, s);
    const parts = content.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    const said = parts.map((p) => p.text || '').join('').trim();
    if (!calls.length) {
      answer = said;
      break;
    }
    contents.push({ role: 'model', parts });
    const responses = [];
    for (const { functionCall: c } of calls) {
      let result;
      if (ACTIONS.has(c.name)) {
        try {
          if (c.name === 'set_setting') settingPatch(c.args?.name, c.args?.value); // validate now
          actions.push({ name: c.name, args: c.args || {} });
          result = { status: 'tasdiq kutilmoqda', note: "Admin ✅ bosgandan keyin bajariladi" };
        } catch (e) {
          result = { error: errText(e) };
        }
      } else if (READ[c.name]) {
        result = await READ[c.name](c.args || {}).catch((e) => ({ error: errText(e) }));
      } else {
        result = { error: `noma'lum asbob ${c.name}` };
      }
      responses.push({ functionResponse: { name: c.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responses });
    if (said) answer = said;
  }
  if (!answer) answer = actions.length ? 'Quyidagilarni bajarishga tayyorman — tasdiqlang:' : "Kechirasiz, javob tayyorlay olmadim. Savolni boshqacha yozib ko'ring.";
  const nextHist = [...hist, { role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: answer }] }].slice(-MAX_TURNS);
  await db.redis().set(HIST(uid), nextHist, { ex: 60 * 60 * 3 }).catch(() => {});
  return { answer, actions };
}

const chunks = (t, n = 3900) => {
  const out = [];
  let rest = String(t);
  while (rest.length > n) {
    const cut = rest.lastIndexOf('\n', n) > n / 2 ? rest.lastIndexOf('\n', n) : n;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
};

// Admin message -> answer (+ a confirm card per action).
export async function runAgent(chatId, uid, text) {
  if (!agentReady()) {
    return tg('sendMessage', { chat_id: chatId, text: "🤖 AI yordamchi uchun GEMINI_API_KEY kerak (Vercel → Settings → Environment Variables)." });
  }
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  let r;
  try {
    r = await think(uid, text, await db.getSettings());
  } catch (e) {
    console.error('agent failed:', e);
    return tg('sendMessage', { chat_id: chatId, text: `🤖 Xato: ${errText(e)}` });
  }
  for (const part of chunks(`🤖 ${r.answer}`)) {
    await tg('sendMessage', { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } });
  }
  await sendActionCards(chatId, uid, r.actions);
  return null;
}

// One "✅ Bajarish / ❌ Bekor" card per action (lib/holiday.js uses it too).
export async function sendActionCards(chatId, uid, actions) {
  for (const a of actions.slice(0, 5)) {
    const id = randomBytes(6).toString('hex');
    await db.redis().set(ACT(id), { ...a, uid: String(uid) }, { ex: 60 * 60 * 6 });
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Tasdiqlaysizmi?\n\n${describeAction(a)}`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Bajarish', callback_data: `ag:y:${id}` }, { text: '❌ Bekor', callback_data: `ag:n:${id}` }]] },
    });
  }
}

// "ag:y:<id>" / "ag:n:<id>" from the confirm card.
export async function agentConfirm(cb, yes, id) {
  const chatId = cb.message?.chat.id;
  const key = ACT(id);
  const a = await db.redis().get(key);
  const edit = (text) =>
    tg('editMessageText', { chat_id: chatId, message_id: cb.message?.message_id, text: text.slice(0, 4000) }).catch(() =>
      tg('sendMessage', { chat_id: chatId, text: text.slice(0, 4000) }),
    );
  if (!a || String(a.uid) !== String(cb.from.id)) return edit('⌛ Bu amal eskirgan yoki allaqachon bajarilgan.');
  await db.redis().del(key);
  if (!yes) return edit(`❌ Bekor qilindi:\n${describeAction(a)}`);
  await edit(`⏳ Bajarilmoqda...\n${describeAction(a)}`);
  try {
    return edit(`${describeAction(a)}\n\n${await runAction(a)}`);
  } catch (e) {
    return edit(`${describeAction(a)}\n\n❌ ${errText(e)}`);
  }
}

export const clearAgentHistory = (uid) => db.redis().del(HIST(uid));

// ---- 📈 the evening analysis ----

export async function agentAnalysis(s) {
  const [dash, day, week, reorder, slow, posts] = await Promise.all([
    READ.dashboard_summary().catch((e) => ({ error: errText(e) })),
    READ.sales({ days: 1 }).catch((e) => ({ error: errText(e) })),
    READ.sales({ days: 7 }).catch((e) => ({ error: errText(e) })),
    READ.reorder().catch((e) => ({ error: errText(e) })),
    READ.slow_movers().catch((e) => ({ error: errText(e) })),
    READ.post_sales({ days: 7 }).catch((e) => ({ error: errText(e) })),
  ]);
  const prompt =
    "Quyidagi ma'lumotlar asosida do'kon egasiga bugungi kun bo'yicha qisqa tahlil yoz (o'zbekcha, 12–18 qator, oddiy matn, emoji bilan):\n" +
    "1) Bugungi savdo va hafta bilan solishtirish; 2) eng yaxshi sotilganlar; 3) bot ishi (postlar, istoriyalar, xatolar); " +
    "4) qaysi post turlari sotuv olib keldi (post_to_sales); 5) buyurtma qilish kerak bo'lganlar; 6) ertaga uchun 3 ta aniq tavsiya (nimani post qilish, nimani chegirmaga qo'yish).\n\n" +
    JSON.stringify({ bot: dash, sales_today: day, sales_week: week, reorder, slow_movers: slow, post_to_sales: posts }).slice(0, 30000);
  const content = await gemini([{ role: 'user', parts: [{ text: prompt }] }], s, { tools: false, temperature: 0.5 });
  return (content.parts || []).map((p) => p.text || '').join('').trim();
}

// Called by the 15-minute job: once a day after 21:00 Tashkent (settings.agent_daily, on by default).
export async function agentDaily(s, now = Date.now()) {
  if (!agentReady() || !agentDailyOn(s) || tashkentHour(now) < DAILY_HOUR) return { skipped: true };
  if (!(await db.once(`agent:daily:${db.today(now)}`, 60 * 60 * 30))) return { skipped: 'done today' };
  try {
    const text = await agentAnalysis(s);
    if (text) {
      for (const part of chunks(`📈 Kunlik AI tahlil\n\n${text}`)) await notifyAdmins({ text: part });
    }
    return { sent: Boolean(text) };
  } catch (e) {
    await db.clearFlag(`agent:daily:${db.today(now)}`); // try again next tick
    return { error: errText(e) };
  }
}
