// «❌ Tugadi» guruhi yangi ulanganda: guruhda alohida tema (forum topic) ochiladi va hozir tugagan hamma mahsulot
// o'sha temaga qaytadan yuboriladi (albomlar, Telegram limiti: guruhga ~20 xabar/daqiqa — shuning uchun bosqichma-bosqich,
// har 15 daqiqalik tikda). Tugagach yangi «❌ TUGADI» xabarlari ham shu temaga boradi (stock.js sendAlerts).
// Holat: Redis K.flag('outbf') = { chat, thread, total, sent, started, done, error }, navbat: K.flag('outbf:q') (pid ro'yxati).
import { getRecord, rememberProductMsg } from './stock.js';
import { richCaption, sendProduct } from './richcaption.js';
import { soldItems } from './soldweb.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { catResolver, forgetThread, isThreadGone, rootResolver, threadFor, topicReason } from './cattopics.js';
import { errText } from './util.js';

const ST = () => db.K.flag('outbf');
const Q = () => db.K.flag('outbf:q');
const OLD = () => db.K.flag('outbf:old');
const CAT = () => db.K.flag('outbf:cat');
export const REFRESH_DEFAULT_H = 40; // Telegram 48 soatdan eski xabarni o'chirtirmaydi — shuning uchun 40
const TITLE = '❌ Tugagan mahsulotlar';
const ALBUM = 10; // bitta kategoriyadan bir martada olinadigan mahsulotlar soni (har biri alohida xabar)
const SEND_GAP_MS = 3200; // Telegram: guruhga ~20 xabar/daqiqa
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
  if (!refresh) await deleteOld(); // qo'lda qayta boshlash: eskilari darrov o'chadi (takroriy xabar bo'lmasin); avto-yangilashda — yangilari yuborilgach
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
  if (!(await db.lock('outbf', 200))) return 0; // bir vaqtda faqat bitta (cron yoki tugma)
  try {
    return await outBackfillTickInner(deadline);
  } finally {
    await db.unlock('outbf').catch(() => {});
  }
}

async function outBackfillTickInner(deadline) {
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
  let cr = null;
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
    let extra = {};
    if (st.topic !== false) {
      try {
        extra = { message_thread_id: await threadFor('outbf', '', st.chat, root) };
      } catch (e) {
        st.topic = false; // forum emas / huquq yo'q: oddiy chatga yuboramiz
        st.topic_err = topicReason(e);
      }
    }
    cr ||= await catResolver(await db.getSettings());
    let failed = null;
    for (let k = 0; k < recs.length; k++) {
      const x = recs[k];
      if (Date.now() + 5000 > deadline) {
        await db.redis().lpush(Q(), ...recs.slice(k).map((y) => y.pid).reverse()); // vaqt tugadi: qolganlari keyingi tikda
        break;
      }
      try {
        const m = await sendProduct(st.chat, extra, x.r, richCaption(x.r, { head: '❌ TUGADI', path: cr.path(x.r) }));
        await rememberProductMsg(x.pid, st.chat, m, Boolean(x.r.img)); // qayta kelsa o'chiriladi («✅ QAYTA KELDI»)
        sent++;
        st.sent++;
      } catch (e) {
        failed = { e, rest: recs.slice(k).map((y) => y.pid) };
        break;
      }
      await sleep(SEND_GAP_MS);
    }
    if (recs.length) st.last_at = Date.now();
    console.log(`stockbf out: batch ${root} ${recs.length} ta, jami ${st.sent}/${st.total}${failed ? ' xato: ' + errText(failed.e).slice(0, 120) : ''}`);
    st.sent += pids.length - recs.length; // allaqachon qayta kelgan (tugamagan) mahsulotlar
    if (failed) {
      const msg = errText(failed.e);
      await db.redis().lpush(Q(), ...failed.rest.reverse());
      const wait = /retry after (\d+)/i.exec(msg);
      if (wait) {
        st.pause_until = Date.now() + (Number(wait[1]) + 2) * 1000;
        st.error = msg.slice(0, 160);
        break;
      }
      if (isThreadGone(failed.e) && extra.message_thread_id) {
        await forgetThread('outbf', st.chat, root); // tema o'chirilgan: keyingi urinishda yangisi ochiladi
        st.gone = (st.gone || 0) + 1;
        if (st.gone > 5) {
          st.topic = false;
          st.topic_err = "tema qayta-qayta o'chirilgan";
        }
        continue;
      }
      st.error = msg.slice(0, 160);
      break;
    }
  }
  const live = await outbfState();
  if (live && live.chat) st.chat = live.chat; // guruh ko'chirilgan bo'lsa, yangi id yo'qolmasin
  if (live && live.stopped) return sent; // tick vaqtida «to'xtatish» bosilgan bo'lsa, qayta yoqib yubormaymiz
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
    return await threadFor('outbf', '', chat, root);
  } catch (e) {
    console.error(`outThreadFor: ${errText(e)}`);
    return null;
  }
}
