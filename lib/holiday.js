// "🎁 Bayram rejimi": a week before a gift holiday the AI picks 6–8 fitting products that are in stock and
// sell well, writes a channel post for the holiday and sends both to the owner as "✅ Bajarish / ❌ Bekor"
// cards (lib/agent.js): nothing is posted before the owner presses ✅. settings.holiday_mode (on by default).

import { callGemini, parseJson } from './ai.js';
import { formatPrice, getProductById, loadDiscounts, priceFor, productImage, productStock } from './bito.js';
import { sendActionCards } from './agent.js';
import { channel2Owner } from './channel2.js';
import { salesByItem } from './sales.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText, mapLimit } from './util.js';

const DAY = 86400000;
const LEAD_DAYS = 7; // prepared this many days before
const PREPARE_HOUR = 10; // ... after 10:00 Tashkent

export const HOLIDAYS = [
  { id: 'defenders', md: '01-14', name: 'Vatan himoyachilari kuni', hint: 'erkaklar, otalar, akalar uchun sovg\'alar' },
  { id: 'valentine', md: '02-14', name: 'Sevishganlar kuni (14-fevral)', hint: 'sevgan insonga romantik sovg\'alar' },
  { id: 'women', md: '03-08', name: 'Xalqaro xotin-qizlar kuni (8-mart)', hint: 'onalar, opa-singillar, ayollar uchun sovg\'alar' },
  { id: 'navruz', md: '03-21', name: "Navro'z bayrami", hint: 'bayramona, oilaviy, bahor ruhidagi sovg\'alar' },
  { id: 'children', md: '06-01', name: 'Xalqaro bolalarni himoya qilish kuni (1-iyun)', hint: 'bolalar uchun o\'yinchoq va sovg\'alar' },
  { id: 'school', md: '09-01', name: 'Mustaqillik kuni va Bilimlar kuni (1-sentabr)', hint: 'o\'quvchilar va bayram uchun sovg\'alar' },
  { id: 'teachers', md: '10-01', name: "O'qituvchi va murabbiylar kuni (1-oktabr)", hint: 'ustozlarga minnatdorchilik sovg\'alari' },
  { id: 'newyear', md: '12-31', name: 'Yangi yil', hint: 'yangi yil sovg\'alari, oila va do\'stlar uchun' },
];

export const holidayOn = (s) => s.holiday_mode !== false;

const tashkentDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
const tashkentHour = (ms) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date(ms))) % 24;

// Next holidays within `within` days: [{ ...holiday, date: 'YYYY-MM-DD', days }]
export function upcomingHolidays(now = Date.now(), within = 60) {
  const today = tashkentDay(now);
  const year = Number(today.slice(0, 4));
  const t0 = Date.parse(`${today}T00:00:00Z`);
  const out = [];
  for (const h of HOLIDAYS) {
    for (const y of [year, year + 1]) {
      const date = `${y}-${h.md}`;
      const days = Math.round((Date.parse(`${date}T00:00:00Z`) - t0) / DAY);
      if (days >= 0 && days <= within) {
        out.push({ ...h, date, days });
        break;
      }
    }
  }
  return out.sort((a, b) => a.days - b.days);
}

// Products in stock, with photo and price, best sellers of the last 30 days first.
async function candidates(limit = 40) {
  const sales = await salesByItem(30).catch(() => null);
  const rows = [...(sales?.rows || [])].sort((a, b) => b.sold - a.sold).slice(0, 60);
  const discounts = await loadDiscounts().catch(() => undefined);
  const found = await mapLimit(rows, 5, async (r) => {
    const p = await getProductById(r.pid).catch(() => null);
    if (!p || productStock(p) <= 0 || !productImage(p)) return null;
    const pr = await priceFor(p, discounts).catch(() => null);
    if (!(pr?.price > 0)) return null;
    return { sku: String(p.sku), name: p.name, price: formatPrice(pr.price), category: r.category || null, sold_30d: r.sold };
  });
  return found.filter(Boolean).slice(0, limit);
}

// AI draft for one holiday: { text, skus, reasons }.
export async function draftHoliday(h, s) {
  const list = await candidates();
  if (list.length < 3) throw new Error("Bayram uchun yetarli mahsulot topilmadi (oxirgi 30 kun savdosi kam yoki qoldiq yo'q)");
  const prompt =
    `Sen Mixpodarok sovg'a do'koni uchun Telegram kanal posti yozasan. Bayram: ${h.name} (${h.date}). Kimlar uchun: ${h.hint}.\n` +
    `Quyidagi mahsulotlardan bayramga eng mos 6–8 tasini tanla (faqat ro'yxatdagi SKU'lardan) va kanal uchun bitta post matnini yoz: ` +
    `o'zbek tilida (lotin), iliq va qisqa (5–9 qator), emoji me'yorida, bayram tabrigi + "sovg'a tanlashga yordam beramiz" g'oyasi, ` +
    `buyurtma uchun telefon: ${s.phone || ''}. Narxlarni matnga yozma (mahsulotlar alohida post bo'ladi).\n` +
    `Faqat JSON qaytar: {"text": "...", "skus": ["..."], "reasons": {"SKU": "nega mos, 3-6 so'z"}}\n\n` +
    JSON.stringify(list);
  const ans = parseJson(await callGemini([{ text: prompt }], { json: true, temperature: 0.7 }));
  const known = new Set(list.map((p) => p.sku));
  const skus = [...new Set([].concat(ans?.skus || []).map(String))].filter((x) => known.has(x)).slice(0, 8);
  if (!ans?.text || !skus.length) throw new Error("AI bayram postini tayyorlay olmadi");
  return { text: String(ans.text).trim(), skus, reasons: ans.reasons || {}, list: list.filter((p) => skus.includes(p.sku)) };
}

// Sends the draft to the owner (or chatId) as confirm cards.
export async function prepareHoliday(h, s, chatId = channel2Owner()) {
  const d = await draftHoliday(h, s);
  const lines = d.list.map((p, i) => `${i + 1}. ${p.sku} ${p.name} — ${p.price}${d.reasons[p.sku] ? ` (${d.reasons[p.sku]})` : ''}`);
  const intro =
    `🎁 Bayram rejimi: ${h.name} — ${h.days === 0 ? 'bugun' : `${h.days} kundan keyin`} (${h.date.split('-').reverse().join('.')})\n\n` +
    `AI tanlagan mahsulotlar:\n${lines.join('\n')}\n\nQuyidagi ikkala kartochkani ko'rib chiqing: ✅ bossangiz joylanadi.`;
  await tg('sendMessage', { chat_id: chatId, text: intro.slice(0, 4000) });
  await sendActionCards(chatId, channel2Owner(), [
    { name: 'post_text', args: { text: d.text } },
    { name: 'post_products', args: { skus: d.skus, targets: ['channel', 'story'] } },
  ]);
  return { holiday: h.id, skus: d.skus };
}

// Called by the 15-minute job: one draft per holiday, LEAD_DAYS before it, after 10:00.
export async function holidayTick(s, now = Date.now()) {
  if (!holidayOn(s) || !process.env.GEMINI_API_KEY || tashkentHour(now) < PREPARE_HOUR) return { skipped: true };
  const due = upcomingHolidays(now, LEAD_DAYS).filter((h) => h.days >= 1);
  for (const h of due) {
    const flag = `holiday:${h.date}:${h.id}`;
    if (!(await db.once(flag, 60 * 60 * 24 * 40))) continue;
    try {
      return await prepareHoliday(h, s);
    } catch (e) {
      await tg('sendMessage', { chat_id: channel2Owner(), text: `🎁 ${h.name}: bayram posti tayyorlanmadi — ${errText(e)}` }).catch(() => {});
      return { error: errText(e) };
    }
  }
  return { due: due.length };
}
