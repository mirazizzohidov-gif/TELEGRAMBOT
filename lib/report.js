import * as db from './store.js';
import { tg } from './telegram.js';
import { waitingCount } from './waitlist.js';
import { adminIds } from './util.js';

export async function buildReport(day = db.today()) {
  const [st, seen, s, queue, storyQueue, biz] = await Promise.all([
    db.getStats(day),
    db.getSeen(day),
    db.getSettings(),
    db.queueLength(),
    db.storyQueueLength(),
    db.listBiz(),
  ]);
  const profiles = db.storyProfiles(s, biz);
  const announcedCount = Object.keys(await db.getAnnounced()).length;
  const perProfile = (base, limit) =>
    profiles.length ? profiles.map((p) => `${p.label} ${st[`${base}:${p.id}`] || 0}/${limit}`).join(', ') : "profil yo'q";
  const n = (k) => st[k] || 0;
  const reasons = { ok: 0, noimage: 0, noprice: 0, nostock: 0, dup: 0 };
  for (const r of Object.values(seen)) {
    reasons[r] = (reasons[r] || 0) + 1;
  }
  const skipped = reasons.noimage + reasons.noprice + reasons.nostock + reasons.dup;
  const lines = [
    `📊 <b>Hisobot — ${day}</b>`,
    '',
    `🆕 Yangi mahsulotlar topildi: ${reasons.ok + skipped}`,
    `✅ Kanalga joylandi: ${n('posted')}`,
    `📱 Story: ${n('stories')} (${perProfile('stories', db.storyDailyLimit(s))})`,
    `⏭ O'tkazib yuborildi: ${skipped}`,
    `   • rasmsiz: ${reasons.noimage}`,
    `   • narxsiz: ${reasons.noprice}`,
    `   • qoldiq 0: ${reasons.nostock}`,
    `   • takror: ${reasons.dup}`,
    `🔥 Chegirma: ${n('discount')} topildi, kanalga ${n('discount_posted')}, story ${n('discount_stories')} (${perProfile('discount_stories', db.discountStoryLimit(s))})`,
    `🔥 Faol chegirmalar: ${n('active_discounts')} ta, e'lon qilingan: ${announcedCount} ta`,
    `♻️ Yana sotuvda: ${n('restock')} topildi, ${n('restock_posted')} joylandi`,
    `🔄 Qayta keldi (ombor): ${n('restock_auto')} aniqlandi, ${n('restock_auto_posted')} kanalga joylandi`,
    `🤖 AI tavsif: ${n('ai_desc')} ta yozildi${n('ai_failed') ? `, ${n('ai_failed')} ta xato` : ''}${n('ai_skipped') ? `, ${n('ai_skipped')} ta o'tkazildi` : ''}`,
    `🔔 Kelganda xabar ber: bugun ${n('wait_subscribed')} obuna, ${n('wait_notified')} kishiga xabar, kutayotganlar ${await waitingCount()}`,
    `🎲 Random albom: ${n('random_album')} ta mahsulot`,
  ];
  if (n('failed')) {
    lines.push(`❗ Xato bilan: ${n('failed')}`);
  }
  lines.push(`📦 Navbatda: kanal ${queue}, story ${storyQueue}`);
  return lines.join('\n');
}

export async function notifyAdmins(payload) {
  for (const id of adminIds()) {
    try {
      await tg('sendMessage', { chat_id: id, ...payload });
    } catch (e) {
      console.error('notify admin', id, e.message);
    }
  }
}

export async function sendReportToAdmins(day) {
  await notifyAdmins({ text: await buildReport(day), parse_mode: 'HTML' });
}
