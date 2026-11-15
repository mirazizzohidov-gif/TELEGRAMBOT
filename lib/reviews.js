// "⭐ Sharh yig'ish": a customer whose bot order ("🛒 Buyurtma") was accepted gets one friendly message a
// few days later asking for a rating on Yandex Maps / Google Maps (buttons with the links). Once per
// customer per 60 days, 10 messages per tick at most, only 10:00–21:00 Tashkent.
// settings.reviews = { on, delay_days, text, yandex, google } (dashboard "📈 Statistika").
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

export const REV_DEFAULTS = {
  on: false,
  delay_days: 2,
  text: "Assalomu alaykum! 🎁 Mixpodarok'dan xarid qilganingiz uchun rahmat!\n\nBizga 1 daqiqa vaqt ajratib, xaritada baho qoldirsangiz juda xursand bo'lamiz — bu boshqa xaridorlarga ham yordam beradi 🙏",
  yandex: 'https://yandex.uz/maps/org/202527235826/reviews/',
  google: 'https://www.google.com/maps?cid=2686746721067954201',
};
export const revCfg = (s) => ({ ...REV_DEFAULTS, ...(s?.reviews || {}) });
const ST = () => db.K.flag('reviews:st');

const kb = (c) => ({
  inline_keyboard: [
    ...(c.yandex ? [[{ text: '⭐ Yandex Kartada baho berish', url: c.yandex }]] : []),
    ...(c.google ? [[{ text: '⭐ Google Kartada baho berish', url: c.google }]] : []),
  ],
});

export async function reviewsTick(s, now = Date.now(), { max = 10 } = {}) {
  const c = revCfg(s);
  if (!db.hasRedis() || !c.on || (!c.yandex && !c.google)) return null;
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date(now))) % 24;
  if (h < 10 || h >= 21) return null;
  const all = Object.entries((await db.redis().hgetall(db.K.orders)) || {}).filter(([k, o]) => k !== 'seq' && o && typeof o === 'object');
  const due = all
    .map(([, o]) => o)
    .filter((o) => o.status === 'accepted' && o.chat && !o.review_at && Number(o.done_at) > 0 && now - Number(o.done_at) >= c.delay_days * 86400000 && now - Number(o.done_at) < 30 * 86400000)
    .sort((a, b) => a.done_at - b.done_at);
  let sent = 0;
  for (const o of due) {
    if (sent >= max) break;
    const mark = () => db.redis().hset(db.K.orders, { [o.id]: { ...o, review_at: now } });
    if (!(await db.once(`reviews:asked:${o.chat}`, 60 * 86400))) {
      await mark();
      continue;
    }
    try {
      await tg('sendMessage', { chat_id: o.chat, text: c.text, reply_markup: kb(c), disable_web_page_preview: true });
      sent++;
      await db.incrStat('review_ask');
    } catch (e) {
      console.error(`review ask ${o.id}: ${errText(e)}`);
    }
    await mark();
  }
  if (sent) await db.redis().set(ST(), { at: now, sent }, { ex: 30 * 86400 }).catch(() => {});
  return { sent, waiting: Math.max(0, due.length - sent) };
}

export async function reviewsView(s) {
  const c = revCfg(s);
  const orders = Object.entries((await db.redis().hgetall(db.K.orders).catch(() => null)) || {}).filter(([k]) => k !== 'seq').map(([, o]) => o);
  const asked = orders.filter((o) => o?.review_at).length;
  return { ok: true, cfg: c, last: await db.redis().get(ST()).catch(() => null), asked, accepted: orders.filter((o) => o?.status === 'accepted').length };
}

export async function reviewsSetCfg(body = {}) {
  const cur = revCfg(await db.getSettings());
  const url = (v, d) => {
    if (v == null) return d;
    const t = String(v).trim();
    if (!t) return '';
    return /^https:\/\/[^\s]+$/i.test(t) ? t.slice(0, 300) : d;
  };
  const next = {
    on: 'on' in body ? Boolean(body.on) : cur.on,
    delay_days: body.delay_days == null ? cur.delay_days : Math.min(14, Math.max(0, Math.round(Number(body.delay_days) || 0))),
    text: body.text == null ? cur.text : String(body.text).trim().slice(0, 900) || REV_DEFAULTS.text,
    yandex: url(body.yandex, cur.yandex),
    google: url(body.google, cur.google),
  };
  await db.updateSettings({ reviews: next });
  return { ok: true, cfg: next, message: next.on ? `✅ Buyurtma qabul qilingandan ${next.delay_days} kun keyin baho so'raladi` : "⏸ Sharh so'rash o'chirildi" };
}

// "🧪 O'zimga sinov" — the message goes to the owner
export async function reviewsTest(chatId) {
  const c = revCfg(await db.getSettings());
  await tg('sendMessage', { chat_id: chatId, text: c.text, reply_markup: kb(c), disable_web_page_preview: true });
  return { ok: true, message: "📨 Sinov xabari Telegram'ga yuborildi" };
}
