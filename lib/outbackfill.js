// «❌ Tugadi» guruhi yangi ulanganda: guruhda alohida tema (forum topic) ochiladi va hozir tugagan hamma mahsulot
// o'sha temaga qaytadan yuboriladi (albomlar, Telegram limiti: guruhga ~20 xabar/daqiqa — shuning uchun bosqichma-bosqich,
// har 15 daqiqalik tikda). Tugagach yangi «❌ TUGADI» xabarlari ham shu temaga boradi (stock.js sendAlerts).
// Holat: Redis K.flag('outbf') = { chat, thread, total, sent, started, done, error }, navbat: K.flag('outbf:q') (pid ro'yxati).
import { outAlertCaption, getRecord, rememberProductMsg } from './stock.js';
import { soldItems } from './soldweb.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { forgetThread, isThreadGone, rootResolver, threadFor, topicReason } from './cattopics.js';
import { errText } from './util.js';

const ST = () => db.K.flag('outbf');
const Q = () => db.K.flag('outbf:q');
const OLD = () => db.K.flag('outbf:old');
const CAT = () => db.K.flag('outbf:cat');
export const REFRESH_DEFAULT_H = 40; // Telegram 48 soatdan eski xabarni o'chirtirmaydi — shuning uchun 40
const TITLE = '❌ Tugagan mahsulotlar';
const ALBUM = 10;
const GAP_MS = 30000; // 10 ta xabar / 30 s = 20 / daqiqa
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const outbfState = () => db.redis().get(ST()).catch(() => null);

export async function startOutBackfill(chat, { force = false, refresh = false } = {}) {
  chat = String(chat || '');
  if (!chat || !db.hasRedis()) return { ok: false, message: '❌ Guruh tanlanmagan' };
  const cur = await outbfState();
  if (!force && cur && cur.chat === chat && !cur.done) return { ok: true, state: cur, message: 'Yuborish davom etmoqda' };
  // shu guruhga oldin yuborilgan «TUGADI» xabarlari: yangilari to'liq yuborilgach o'chiriladi
  await db.redis().del(OLD());
  if (cur && cur.chat === chat) {
    const all = Object.values((await db.redis().hgetall(db.K.reportPid)) || {}).flat().filter((m) => String(m.chat) === chat);
    for (let i = 0; i < all.length; i += 500) await db.redis().rpush(OLD(), ...all.slice(i, i + 500).map((m) => ({ chat: m.chat, mid: m.mid })));
  }
  // kategoriya bo'yicha tartiblaymiz: bitta albom — bitta kategoriya, har kategoriya o'z temasiga
  const items = (await soldItems('shop')).items.slice().sort((a, b) => String(a.category || '').localeCompare(String(b.category || '')));
  const pids = items.map((x) => x.pid);
  await db.redis().del(CAT());
  for (let i = 0; i < items.length; i += 300) await db.redis().hset(CAT(), Object.fromEntries(items.slice(i, i + 300).map((x) => [String(x.pid), x.category || 'Kategoriyasiz'])));
  await db.redis().del(Q());
  for (let i = 0; i < pids.length; i += 500) await db.redis().rpush(Q(), ...pids.slice(i, i + 500));
  const state = { chat, total: pids.length, sent: 0, started: Date.now(), done: pids.length === 0, error: null, topic: true, topic_err: null, cycles: (cur && cur.chat === chat ? cur.cycles || 0 : 0) + (refresh ? 1 : 0) };
  await db.redis().set(ST(), state);
  return { ok: true, state, message: `✅ ${pids.length} ta tugagan mahsulot navbatga qo'yildi (har kategoriya o'z temasiga)` };
}

// stockTick'dan: vaqt qolguncha albomlar yuboradi
export async function outBackfillTick(deadline) {
  let st = await outbfState();
  if (!st) return 0;
  const h = await refreshHours();
  if (st.done && !st.stopped && h > 0 && Date.now() - (st.started || 0) >= h * 3600e3) {
    const r = await startOutBackfill(st.chat, { force: true, refresh: true }).catch((e) => ({ ok: false, message: errText(e) }));
    if (!r.ok) return 0;
    st = r.state;
  }
  if (st.done && (await db.redis().llen(OLD()).catch(() => 0)) > 0 && !(await db.redis().llen(Q()).catch(() => 0))) await deleteOld();
  if (st.done || (st.pause_until && st.pause_until > Date.now())) return 0;
  let sent = 0;
  while (Date.now() + 12000 < deadline) {
    const pids = [];
    let root = null;
    for (let i = 0; i < ALBUM; i++) {
      const pid = await db.redis().lpop(Q());
      if (!pid) break;
      const c = (await db.redis().hget(CAT(), String(pid))) || 'Kategoriyasiz';
      if (root !== null && c !== root) {
        await db.redis().lpush(Q(), pid); // keyingi kategoriya — keyingi albomda
        break;
      }
      root = c;
      pids.push(String(pid));
    }
    if (!pids.length) {
      st.done = true;
      st.done_at = Date.now();
      await db.redis().set(ST(), st);
      await deleteOld();
      return sent;
    }
    const recs = (await Promise.all(pids.map(async (pid) => ({ pid, r: await getRecord(pid) })))).filter((x) => x.r && !(x.r.stock > 0));
    const withImg = recs.filter((x) => x.r.img);
    const noImg = recs.filter((x) => !x.r.img);
    let extra = {};
    if (st.topic !== false) {
      try {
        extra = { message_thread_id: await threadFor('outbf', '❌', st.chat, root) };
      } catch (e) {
        st.topic = false; // forum emas / huquq yo'q: oddiy chatga yuboramiz
        st.topic_err = topicReason(e);
      }
    }
    try {
      // yuborilgan xabarlar eslab qolinadi: mahsulot qayta kelsa o'chiriladi («✅ QAYTA KELDI»)
      if (withImg.length > 1) {
        const msgs = await tg('sendMediaGroup', { chat_id: st.chat, ...extra, media: withImg.map((x) => ({ type: 'photo', media: x.r.img, caption: outAlertCaption(x.r) })) });
        for (let i = 0; i < withImg.length; i++) await rememberProductMsg(withImg[i].pid, st.chat, msgs?.[i], true);
      } else if (withImg.length === 1) {
        const m = await tg('sendPhoto', { chat_id: st.chat, ...extra, photo: withImg[0].r.img, caption: outAlertCaption(withImg[0].r) });
        await rememberProductMsg(withImg[0].pid, st.chat, m, true);
      }
      if (noImg.length) {
        const m = await tg('sendMessage', { chat_id: st.chat, ...extra, text: `🖼 Rasmsiz:\n\n${noImg.map((x) => outAlertCaption(x.r)).join('\n\n')}`.slice(0, 4000) });
        for (const x of noImg) await rememberProductMsg(x.pid, st.chat, m, false);
      }
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
      if (isThreadGone(e) && extra.message_thread_id) {
        await forgetThread('outbf', st.chat, root); // tema o'chirilgan: keyingi urinishda yangisi ochiladi
        await db.redis().lpush(Q(), ...pids.reverse());
        st.gone = (st.gone || 0) + 1;
        if (st.gone > 5) {
          st.topic = false;
          st.topic_err = "tema qayta-qayta o'chirilgan";
        }
        continue;
      }
      // rasm olinmasa (bitta buzuq havola) — albomni birma-bir yuboramiz
      for (const x of withImg) {
        const m = await tg('sendPhoto', { chat_id: st.chat, ...extra, photo: x.r.img, caption: outAlertCaption(x.r) }).catch(() => tg('sendMessage', { chat_id: st.chat, ...extra, text: outAlertCaption(x.r) }).catch(() => null));
        await rememberProductMsg(x.pid, st.chat, m, true);
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

export async function refreshHours() {
  const v = (await db.getSettings()).out_refresh_h;
  return v == null || v === '' ? REFRESH_DEFAULT_H : Math.max(0, Number(v) || 0);
}

// Eski (oldingi yuborishdagi) xabarlarni o'chiradi; 48 soatdan eskilari Telegram'da o'chmaydi — o'tkazib yuboriladi.
async function deleteOld() {
  const old = (await db.redis().lrange(OLD(), 0, -1)) || [];
  await db.redis().del(OLD());
  if (!old.length) return;
  const gone = new Set();
  const byChat = {};
  for (const m of old) (byChat[m.chat] ||= []).push(m.mid);
  for (const [chat, ids] of Object.entries(byChat)) {
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      await tg('deleteMessages', { chat_id: chat, message_ids: part }).catch((e) => console.error(`outbackfill delete old: ${errText(e)}`));
      part.forEach((id) => gone.add(`${chat}:${id}`));
    }
  }
  const all = (await db.redis().hgetall(db.K.reportPid)) || {};
  for (const [pid, arr] of Object.entries(all)) {
    const keep = arr.filter((m) => !gone.has(`${m.chat}:${m.mid}`));
    if (keep.length === arr.length) continue;
    if (keep.length) await db.redis().hset(db.K.reportPid, { [pid]: keep });
    else await db.redis().hdel(db.K.reportPid, pid);
  }
  console.log(`outbackfill: ${old.length} old messages deleted`);
}

export async function stopOutBackfill() {
  const st = await outbfState();
  await db.redis().del(Q());
  await db.redis().del(OLD());
  if (st) await db.redis().set(ST(), { ...st, done: true, stopped: true, pause_until: null });
}

// yangi «TUGADI» xabari uchun kategoriya temasi (forum bo'lmasa yoki qayta yuborish ishlatilmagan bo'lsa — null)
export async function outThreadFor(s, chat, pid, rec) {
  const st = await outbfState().catch(() => null);
  if (!st || String(st.chat) !== String(chat) || st.topic === false) return null;
  try {
    const root = (await db.redis().hget(CAT(), String(pid))) || (await rootResolver(s))(rec);
    return await threadFor('outbf', '❌', chat, root);
  } catch (e) {
    console.error(`outThreadFor: ${errText(e)}`);
    return null;
  }
}
