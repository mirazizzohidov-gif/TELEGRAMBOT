import * as db from './store.js';
import { tg } from './telegram.js';
import { adminIds } from './util.js';

export async function buildReport(day = db.today()) {
  const st = await db.getStats(day);
  const queue = await db.queueLength();
  const n = (k) => st[k] || 0;
  const skipped = n('skip_noimage') + n('skip_noprice') + n('skip_nostock') + n('skip_dup');
  const lines = [
    `📊 <b>Hisobot — ${day}</b>`,
    '',
    `🆕 Yangi mahsulotlar topildi: ${n('found')}`,
    `📥 Navbatga qo'yildi: ${n('queued') + n('random_queued')}${n('random_queued') ? ` (tasodifiy: ${n('random_queued')})` : ''}`,
    `✅ Joylandi: ${n('posted')}`,
    `⏭ O'tkazib yuborildi: ${skipped}`,
    `   • rasmsiz: ${n('skip_noimage')}`,
    `   • narxsiz: ${n('skip_noprice')}`,
    `   • qoldiq 0: ${n('skip_nostock')}`,
    `   • takror: ${n('skip_dup')}`,
    `📱 Story: ${n('stories')}`,
    `🔥 Chegirma: ${n('discount_posted')} joylandi (${n('discount')} topildi)`,
    `♻️ Yana sotuvda: ${n('restock_posted')} joylandi (${n('restock')} topildi)`,
  ];
  if (n('failed')) {
    lines.push(`❗ Xato bilan: ${n('failed')}`);
  }
  lines.push(`📦 Navbatda qoldi: ${queue}`);
  if (n('no_new')) {
    lines.push('', "ℹ️ Bugun yangi mahsulot yo'q (random rejim o'chiq).");
  }
  if (n('random_asked')) {
    lines.push('', "ℹ️ Bugun yangi mahsulot yo'q — tasodifiy mahsulotlar so'raldi.");
  }
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
