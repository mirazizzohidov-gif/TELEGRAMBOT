// «❌ Tugadi» guruhi yangi ulanganda: guruhda alohida tema (forum topic) ochiladi va hozir tugagan hamma mahsulot
// o'sha temaga qaytadan yuboriladi (albomlar, Telegram limiti: guruhga ~20 xabar/daqiqa — shuning uchun bosqichma-bosqich,
// har 15 daqiqalik tikda). Tugagach yangi «❌ TUGADI» xabarlari ham shu temaga boradi (stock.js sendAlerts).
// Holat: Redis K.flag('outbf') = { chat, thread, total, sent, started, done, error }, navbat: K.flag('outbf:q') (pid ro'yxati).
import { outAlertCaption, getRecord } from './stock.js';
import { soldItems } from './soldweb.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

const ST = () => db.K.flag('outbf');
const Q = () => db.K.flag('outbf:q');
const TITLE = '❌ Tugagan mahsulotlar';
const ALBUM = 10;
const GAP_MS = 30000; // 10 ta xabar / 30 s = 20 / daqiqa
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const outbfState = () => db.redis().get(ST()).catch(() => null);

export async function startOutBackfill(chat, { force = false } = {}) {
  chat = String(chat || '');
  if (!chat || !db.hasRedis()) return { ok: false, message: '❌ Guruh tanlanmagan' };
  const cur = await outbfState();
  if (!force && cur && cur.chat === chat && !cur.done) return { ok: true, state: cur, message: 'Yuborish davom etmoqda' };
  let thread = null;
  try {
    thread = Number((await tg('createForumTopic', { chat_id: chat, name: TITLE })).message_thread_id) || null;
  } catch (e) {
    console.error(`outbackfill: tema ochilmadi (${errText(e)}) — guruhda «Mavzular» yoqilmagan yoki huquq yo'q; temasiz yuboriladi`);
  }
  const pids = (await soldItems('shop')).items.map((x) => x.pid);
  await db.redis().del(Q());
  for (let i = 0; i < pids.length; i += 500) await db.redis().rpush(Q(), ...pids.slice(i, i + 500));
  const state = { chat, thread, total: pids.length, sent: 0, started: Date.now(), done: pids.length === 0, error: null, topic: thread !== null };
  await db.redis().set(ST(), state);
  return { ok: true, state, message: `✅ ${pids.length} ta tugagan mahsulot navbatga qo'yildi${thread ? ' (yangi tema ochildi)' : " (tema ochilmadi — Mavzular yoqilmagan bo'lishi mumkin, oddiy chatga yuboriladi)"}` };
}

// stockTick'dan: vaqt qolguncha albomlar yuboradi
export async function outBackfillTick(deadline) {
  const st = await outbfState();
  if (!st || st.done || (st.pause_until && st.pause_until > Date.now())) return 0;
  let sent = 0;
  while (Date.now() + 12000 < deadline) {
    const pids = [];
    for (let i = 0; i < ALBUM; i++) {
      const pid = await db.redis().lpop(Q());
      if (!pid) break;
      pids.push(String(pid));
    }
    if (!pids.length) {
      st.done = true;
      break;
    }
    const recs = (await Promise.all(pids.map(async (pid) => ({ pid, r: await getRecord(pid) })))).filter((x) => x.r && !(x.r.stock > 0));
    const withImg = recs.filter((x) => x.r.img);
    const noImg = recs.filter((x) => !x.r.img);
    const extra = st.thread ? { message_thread_id: st.thread } : {};
    try {
      if (withImg.length > 1) await tg('sendMediaGroup', { chat_id: st.chat, ...extra, media: withImg.map((x) => ({ type: 'photo', media: x.r.img, caption: outAlertCaption(x.r) })) });
      else if (withImg.length === 1) await tg('sendPhoto', { chat_id: st.chat, ...extra, photo: withImg[0].r.img, caption: outAlertCaption(withImg[0].r) });
      if (noImg.length) await tg('sendMessage', { chat_id: st.chat, ...extra, text: `🖼 Rasmsiz:\n\n${noImg.map((x) => outAlertCaption(x.r)).join('\n\n')}`.slice(0, 4000) });
      sent += recs.length;
      st.sent += pids.length;
    } catch (e) {
      const msg = errText(e);
      const wait = /retry after (\d+)/i.exec(msg);
      if (wait) {
        await db.redis().lpush(Q(), ...pids.reverse());
        st.pause_until = Date.now() + (Number(wait[1]) + 2) * 1000;
        st.error = msg.slice(0, 160);
        break;
      }
      if (/thread not found|TOPIC_DELETED|TOPIC_CLOSED/i.test(msg)) {
        await db.redis().lpush(Q(), ...pids.reverse());
        st.thread = null; // tema o'chirilgan: oddiy chatga
        st.topic = false;
        continue;
      }
      // rasm olinmasa (bitta buzuq havola) — albomni birma-bir yuboramiz
      for (const x of withImg) {
        await tg('sendPhoto', { chat_id: st.chat, ...extra, photo: x.r.img, caption: outAlertCaption(x.r) }).catch(() => tg('sendMessage', { chat_id: st.chat, ...extra, text: outAlertCaption(x.r) }).catch(() => {}));
        await sleep(3000);
      }
      st.sent += pids.length;
      st.error = msg.slice(0, 160);
    }
    await sleep(GAP_MS);
  }
  await db.redis().set(ST(), st);
  return sent;
}
