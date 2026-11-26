// "📈 Haftalik ijtimoiy tarmoqlar hisoboti": every Monday after 10:00 (Tashkent), to the owner:
// what the bot published last week on each network, followers, views / likes and the best posts.
// settings.weekly_social === false turns it off (dashboard "📈 Statistika").
import { channel2Owner } from './channel2.js';
import { socSales, SOC_NETS } from './socsales.js';
import { socStats } from './socstats.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('ru-RU').replace(/,/g, ' '));
const ICON = { ig: '📸', yt: '▶️', fb: '📘', th: '🧵', tt: '🎵', pin: '📌', tg: '✈️' };

export function weeklyText(d) {
  const a = d.activity;
  const lines = ['📈 <b>Haftalik hisobot — ijtimoiy tarmoqlar</b>', '', '🗓 <b>Bot 7 kunda chiqardi:</b>'];
  for (const [k, label] of Object.entries(d.labels)) if (a.week[k]) lines.push(`${label}: ${fmt(a.week[k])} ta`);
  if (!Object.values(a.week).some(Boolean)) lines.push('— hech narsa');
  if (d.nets.length) {
    lines.push('', '👥 <b>Tarmoqlar (7 kun):</b>');
    for (const n of d.nets) {
      const w = n.week || {};
      const parts = [w.views != null ? `👁 ${fmt(w.views)}` : '', `❤️ ${fmt(w.likes)}`, `💬 ${fmt(w.comments)}`, w.shares ? `🔁 ${fmt(w.shares)}` : ''].filter(Boolean).join(' · ');
      lines.push(`${ICON[n.net] || '•'} ${esc(n.name)} — ${fmt(n.followers)} obunachi${n.delta != null ? ` (${n.delta >= 0 ? '+' : ''}${n.delta})` : ''}\n     ${w.posts || 0} post · ${parts}`);
    }
  }
  if (d.top.length) {
    lines.push('', '🏆 <b>Haftaning eng yaxshilari:</b>');
    d.top.slice(0, 5).forEach((t, i) => lines.push(`${i + 1}. ${ICON[t.net] || ''} <a href="${esc(t.url)}">${esc(t.title)}</a> — ${t.views != null ? `👁 ${fmt(t.views)} · ` : ''}❤️ ${fmt(t.likes)}`));
  }
  const best = d.nets.find((n) => n.best?.length)?.best;
  if (best) lines.push('', `⏰ Instagram uchun eng yaxshi soatlar: ${best.join(', ')}`);
  // 💰 Post → sotuv (lib/socsales.js): qaysi tarmoqda chiqqan mahsulotlar shu hafta sotilgan
  const sl = d.sales;
  if (sl?.nets?.length) {
    lines.push('', `💰 <b>Qaysi tarmoq sotdi (7 kun, taxminiy):</b>`);
    for (const n of sl.nets) lines.push(`${esc(n.label)}: ${fmt(n.products)} mahsulotdan ${fmt(n.sold)} tasi sotildi (${n.rate}%) · ${esc(n.sum_text)}`);
    if (sl.top?.length) {
      lines.push('', '🛒 <b>Eng ko\'p sotilganlar (postdan keyin):</b>');
      sl.top.slice(0, 5).forEach((x, i) => lines.push(`${i + 1}. ${esc(x.name)} — ${fmt(x.units)} dona · ${esc(x.sum_text)} (${x.nets.map((k) => (SOC_NETS[k] || k).split(' ')[0]).join('')})`));
    }
  }
  const errs = Object.keys(d.errors || {});
  if (errs.length) lines.push('', `⚠️ O'qib bo'lmadi: ${errs.join(', ')}`);
  return lines.join('\n').slice(0, 4000);
}

export async function weeklyTick(s, now = Date.now()) {
  if (!db.hasRedis() || s?.weekly_social === false) return null;
  const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  if (local.getDay() !== 1 || local.getHours() < 10) return null; // Monday, from 10:00
  if (!(await db.once(`weekly-social:${db.today(now)}`, 60 * 60 * 30))) return null;
  try {
    const d = await socStats({ refresh: true });
    d.sales = await socSales({ days: 7, top: 5 }).catch(() => null);
    await tg('sendMessage', { chat_id: channel2Owner(), text: weeklyText(d), parse_mode: 'HTML', disable_web_page_preview: true });
    return { sent: true };
  } catch (e) {
    console.error(`weekly social: ${errText(e)}`);
    return { error: errText(e) };
  }
}

// dashboard "📨 Hozir yuborish"
export async function weeklySendNow() {
  const d = await socStats({ refresh: true });
  d.sales = await socSales({ days: 7, top: 5 }).catch(() => null);
  await tg('sendMessage', { chat_id: channel2Owner(), text: weeklyText(d), parse_mode: 'HTML', disable_web_page_preview: true });
  return { ok: true, message: "📨 Hisobot Telegram'ga yuborildi" };
}
