// «⚠️ Kam qoldi» guruhiga hozir kam qolgan (1..chegara dona) hamma mahsulotni alohida temada qaytadan yuboradi.
// Tugma bosilganda ishga tushadi; yuborish bosqichma-bosqich (har tikda). Tugagach oldingi to'plam o'chiriladi.
import { lowAlertCaption, lowRecords, getRecord, withPrice } from './stock.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { forgetThread, isThreadGone, rootResolver, threadFor, topicReason } from './cattopics.js';
import { errText } from './util.js';

const ST = () => db.K.flag('lowbf');
const Q = () => db.K.flag('lowbf:q');
const MSGS = () => db.K.flag('lowbf:msgs');
const OLD = () => db.K.flag('lowbf:old');
const CAT = () => db.K.flag('lowbf:cat');
const TITLE = '⚠️ Kam qolgan mahsulotlar';
const ALBUM = 10;
const GAP_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r = () => db.redis();

export const lowbfState = () => r().get(ST()).catch(() => null);

export async function startLowBackfill(s) {
  const chat = String(s.stock_low_group || '');
  if (!chat || !db.hasRedis()) return { ok: false, message: "❌ Avval «Kam qoldi xabari» uchun guruh tanlang" };
  const cur = await lowbfState();
  await r().del(OLD());
  const prev = (await r().lrange(MSGS(), 0, -1)) || [];
  for (let i = 0; i < prev.length; i += 500) await r().rpush(OLD(), ...prev.slice(i, i + 500));
  await r().del(MSGS());
  const threshold = db.limit(s, 'low_stock_threshold');
  const root = await rootResolver(s);
  const all = (await r().hgetall(db.K.stock)) || {};
  const list = (await lowRecords(s)).filter((x) => x.stock > 0 && x.stock <= threshold).map((x) => ({ pid: x.pid, c: root(all[x.pid]) }));
  list.sort((a, b) => a.c.localeCompare(b.c));
  const pids = list.map((x) => x.pid);
  await r().del(CAT());
  for (let i = 0; i < list.length; i += 300) await r().hset(CAT(), Object.fromEntries(list.slice(i, i + 300).map((x) => [String(x.pid), x.c])));
  await r().del(Q());
  for (let i = 0; i < pids.length; i += 500) await r().rpush(Q(), ...pids.slice(i, i + 500));
  const state = { chat, total: pids.length, sent: 0, started: Date.now(), done: pids.length === 0, error: null, topic: true, topic_err: null };
  await r().set(ST(), state);
  if (!pids.length) await deleteOld();
  return { ok: true, state, message: `✅ ${pids.length} ta kam qolgan mahsulot navbatga qo'yildi (har kategoriya o'z temasiga)` };
}

async function deleteOld() {
  const old = (await r().lrange(OLD(), 0, -1)) || [];
  await r().del(OLD());
  const byChat = {};
  for (const m of old) (byChat[m.chat] ||= []).push(m.mid);
  for (const [chat, ids] of Object.entries(byChat)) {
    for (let i = 0; i < ids.length; i += 100) await tg('deleteMessages', { chat_id: chat, message_ids: ids.slice(i, i + 100) }).catch((e) => console.error(`lowbackfill delete old: ${errText(e)}`));
  }
}

const track = async (chat, msgs) => {
  const arr = (Array.isArray(msgs) ? msgs : [msgs]).map((m) => m?.message_id).filter(Boolean);
  if (arr.length) await r().rpush(MSGS(), ...arr.map((mid) => ({ chat: String(chat), mid })));
};

export async function lowBackfillTick(deadline) {
  const st = await lowbfState();
  if (!st || st.done || (st.pause_until && st.pause_until > Date.now())) return 0;
  let sent = 0;
  while (Date.now() + 12000 < deadline) {
    const pids = [];
    let root = null;
    for (let i = 0; i < ALBUM; i++) {
      const pid = await r().lpop(Q());
      if (!pid) break;
      const c = (await r().hget(CAT(), String(pid))) || 'Kategoriyasiz';
      if (root !== null && c !== root) {
        await r().lpush(Q(), pid);
        break;
      }
      root = c;
      pids.push(String(pid));
    }
    if (!pids.length) {
      st.done = true;
      st.done_at = Date.now();
      await r().set(ST(), st);
      await deleteOld();
      return sent;
    }
    const recs = [];
    for (const pid of pids) {
      const rec = await getRecord(pid);
      if (rec && rec.stock > 0) recs.push({ pid, r: await withPrice(pid, rec) });
    }
    const withImg = recs.filter((x) => x.r.img);
    const noImg = recs.filter((x) => !x.r.img);
    let extra = {};
    if (st.topic !== false) {
      try {
        extra = { message_thread_id: await threadFor('lowbf', '⚠️', st.chat, root) };
      } catch (e) {
        st.topic = false;
        st.topic_err = topicReason(e);
      }
    }
    try {
      if (withImg.length > 1) await track(st.chat, await tg('sendMediaGroup', { chat_id: st.chat, ...extra, media: withImg.map((x) => ({ type: 'photo', media: x.r.img, caption: lowAlertCaption(x.r), parse_mode: 'HTML' })) }));
      else if (withImg.length === 1) await track(st.chat, await tg('sendPhoto', { chat_id: st.chat, ...extra, photo: withImg[0].r.img, caption: lowAlertCaption(withImg[0].r), parse_mode: 'HTML' }));
      if (noImg.length) await track(st.chat, await tg('sendMessage', { chat_id: st.chat, ...extra, parse_mode: 'HTML', text: `🖼 Rasmsiz:\n\n${noImg.map((x) => lowAlertCaption(x.r)).join('\n\n')}`.slice(0, 4000) }));
      for (const x of recs) await r().set(`${db.K.flag(`lowalert:p:${x.pid}`)}`, 1, { ex: 14 * 86400, nx: true }).catch(() => {});
      sent += recs.length;
      st.sent += pids.length;
    } catch (e) {
      const msg = errText(e);
      const wait = /retry after (\d+)/i.exec(msg);
      if (wait) {
        await r().lpush(Q(), ...pids.reverse());
        st.pause_until = Date.now() + (Number(wait[1]) + 2) * 1000;
        st.error = msg.slice(0, 160);
        break;
      }
      if (isThreadGone(e) && extra.message_thread_id) {
        await forgetThread('lowbf', st.chat, root);
        await r().lpush(Q(), ...pids.reverse());
        st.gone = (st.gone || 0) + 1;
        if (st.gone > 5) {
          st.topic = false;
          st.topic_err = "tema qayta-qayta o'chirilgan";
        }
        continue;
      }
      for (const x of withImg) {
        const m = await tg('sendPhoto', { chat_id: st.chat, ...extra, photo: x.r.img, caption: lowAlertCaption(x.r), parse_mode: 'HTML' }).catch(() => tg('sendMessage', { chat_id: st.chat, ...extra, parse_mode: 'HTML', text: lowAlertCaption(x.r) }).catch(() => null));
        await track(st.chat, m);
        await sleep(3000);
      }
      st.sent += pids.length;
      st.error = msg.slice(0, 160);
    }
    await sleep(GAP_MS);
  }
  await r().set(ST(), st);
  return sent;
}

export async function stopLowBackfill() {
  const st = await lowbfState();
  await r().del(Q());
  await r().del(OLD());
  if (st) await r().set(ST(), { ...st, done: true, stopped: true, pause_until: null });
}
