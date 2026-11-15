// «⚠️ Kam qoldi» guruhiga hozir kam qolgan (1..chegara dona) hamma mahsulotni alohida temada qaytadan yuboradi.
// Tugma bosilganda ishga tushadi; yuborish bosqichma-bosqich (har tikda). Tugagach oldingi to'plam o'chiriladi.
import { lowRecords, getRecord, withPrice } from './stock.js';
import { richCaption, sendProduct } from './richcaption.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { catResolver, forgetThread, isThreadGone, threadFor, topicReason } from './cattopics.js';
import { errText } from './util.js';

const ST = () => db.K.flag('lowbf');
async function markDone(pid) {
  try {
    await r().hset(DONE(), { [String(pid)]: 1 });
  } catch (e) {
    console.error(`markDone: ${errText(e)}`); // hisob xatosi yuborishni buzmasin
  }
}
const DONE = () => db.K.flag('lowbf:done');
const IN = () => db.K.flag('lowbf:in');
const Q = () => db.K.flag('lowbf:q');
const MSGS = () => db.K.flag('lowbf:msgs');
const OLD = () => db.K.flag('lowbf:old');
const CAT = () => db.K.flag('lowbf:cat');
const TITLE = '⚠️ Kam qolgan mahsulotlar';
const ALBUM = 10;
const SEND_GAP_MS = 3200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r = () => db.redis();

export const lowbfState = () => r().get(ST()).catch(() => null);

export async function startLowBackfill(s, { resume = false } = {}) {
  const chat = String(s.stock_low_group || '');
  if (!chat || !db.hasRedis()) return { ok: false, message: "❌ Avval «Kam qoldi xabari» uchun guruh tanlang" };
  const cur = await lowbfState();
  if (!resume) {
    await r().del(OLD());
    const prev = (await r().lrange(MSGS(), 0, -1)) || [];
    for (let i = 0; i < prev.length; i += 500) await r().rpush(OLD(), ...prev.slice(i, i + 500));
    await r().del(MSGS());
    await deleteOld(); // eskilari darrov o'chadi (takroriy xabar bo'lmasin)
    await r().del(DONE());
  }
  const threshold = db.limit(s, 'low_stock_threshold');
  const cr = await catResolver(s);
  const root = cr.root;
  const all = (await r().hgetall(db.K.stock)) || {};
  const list = (await lowRecords(s)).filter((x) => x.stock > 0 && x.stock <= threshold).map((x) => ({ pid: x.pid, c: root(all[x.pid]) }));
  list.sort((a, b) => a.c.localeCompare(b.c));
  const doneSet = resume ? new Set(Object.keys((await r().hgetall(DONE())) || {})) : new Set();
  const total = list.length;
  const pids = list.filter((x) => !doneSet.has(String(x.pid))).map((x) => x.pid);
  await r().del(CAT());
  for (let i = 0; i < list.length; i += 300) await r().hset(CAT(), Object.fromEntries(list.slice(i, i + 300).map((x) => [String(x.pid), x.c])));
  await r().del(db.K.flag('lowbf:fail'));
  await r().del(Q());
  await r().del(IN());
  for (let i = 0; i < pids.length; i += 500) await r().rpush(Q(), ...pids.slice(i, i + 500));
  const state = { chat, total: resume ? total : pids.length, sent: resume ? total - pids.length : 0, started: Date.now(), done: pids.length === 0, error: null, topic: true, topic_err: null };
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
  if (!(await db.lock('lowbf', 200))) return 0; // bir vaqtda faqat bitta (cron yoki tugma)
  try {
    return await lowBackfillTickInner(deadline);
  } finally {
    await db.unlock('lowbf').catch(() => {});
  }
}

async function lowBackfillTickInner(deadline) {
  const st = await lowbfState();
  if (!st || st.done || (st.pause_until && st.pause_until > Date.now())) return 0;
  // oldingi tsikl o'rtada o'lgan bo'lsa, o'sha albom yo'qolmasin: navbat boshiga qaytariladi
  const lost = (await r().lrange(IN(), 0, -1)) || [];
  if (lost.length) {
    await r().lpush(Q(), ...lost.slice().reverse());
    await r().del(IN());
    console.log(`stockbf low: ${lost.length} ta yo'qolgan mahsulot navbatga qaytarildi`);
  }
  let sent = 0;
  let cr = null;
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
    if (pids.length) await r().del(IN()).then(() => r().rpush(IN(), ...pids));
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
    let extra = {};
    // temasiz (aralash) yuborilmaydi: tema ochilmasa navbat saqlanib, 60 soniyadan keyin qayta uriniladi
    try {
      extra = { message_thread_id: await threadFor('lowbf', '', st.chat, root) };
      st.topic = true;
      st.topic_err = null;
    } catch (e) {
      st.topic = false;
      st.topic_err = topicReason(e);
      st.error = st.topic_err;
      console.log(`stockbf low: tema ochilmadi (${root}): ${errText(e).slice(0, 140)}`);
      await r().lpush(Q(), ...pids.slice().reverse());
      st.pause_until = Date.now() + 60000;
      break;
    }
    cr ||= await catResolver(await db.getSettings());
    let failed = null;
    let bad = 0;
    for (let k = 0; k < recs.length; k++) {
      const x = recs[k];
      if (Date.now() + 5000 > deadline) {
        await r().lpush(Q(), ...recs.slice(k).map((y) => y.pid).reverse()); // vaqt tugadi: qolganlari keyingi tikda
        break;
      }
      try {
        const m = await sendProduct(st.chat, extra, x.r, richCaption(x.r, { head: '⚠️ KAM QOLDI', path: cr.path(x.r), low: true }));
        await track(st.chat, m);
        await db.once(`lowalert:p:${x.pid}`, 14 * 86400).catch(() => {});
        await markDone(x.pid);
        sent++;
        st.sent++;
        st.error = null; // eski vaqtinchalik xato ko'rinib turmasin
      } catch (e) {
        const fatal = /retry after|thread not found|TOPIC_|not a forum|rights|upgraded/i.test(errText(e));
        if (fatal) {
          failed = { e, rest: recs.slice(k).map((y) => y.pid) };
          break;
        }
        // shu mahsulotning o'zida muammo (timeout, buzuq rasm/matn): bir marta qayta urinamiz, keyin o'tkazib yuboramiz — navbat qotib qolmasin
        const tries = await r().hincrby(db.K.flag('lowbf:fail'), String(x.pid), 1).catch(() => 9);
        console.log(`stockbf lowbf: ${x.r.sku} xato (${tries}): ${errText(e).slice(0, 100)}`);
        if (tries >= 2) {
          st.skipped = (st.skipped || 0) + 1;
          st.sent++;
        } else await r().rpush(Q(), String(x.pid));
        st.error = errText(e).slice(0, 160);
        if (++bad >= 4) {
          failed = { e, rest: recs.slice(k + 1).map((y) => y.pid) };
          break;
        }
        continue;
      }
      await sleep(SEND_GAP_MS);
    }
    if (recs.length) st.last_at = Date.now();
    console.log(`stockbf low: batch ${root} ${recs.length} ta, jami ${st.sent}/${st.total}${failed ? ' xato: ' + errText(failed.e).slice(0, 120) : ''}`);
    st.sent += pids.length - recs.length;
    if (!failed) {
      await r().del(IN());
      const lv = await lowbfState();
      if (lv && lv.stopped) return sent; // to'xtatilgan: yozmaymiz
      if (lv && lv.chat) st.chat = lv.chat;
      await r().set(ST(), st); // har albomdan keyin saqlanadi: tsikl o'lsa ham hisob yo'qolmaydi
    }
    if (failed) {
      await r().del(IN());
      const msg = errText(failed.e);
      await r().lpush(Q(), ...failed.rest.reverse());
      const wait = /retry after (\d+)/i.exec(msg);
      if (wait) {
        st.pause_until = Date.now() + (Number(wait[1]) + 2) * 1000;
        st.error = msg.slice(0, 160);
        break;
      }
      if (isThreadGone(failed.e) && extra.message_thread_id) {
        await forgetThread('lowbf', st.chat, root);
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
  const live = await lowbfState();
  if (live && live.chat) st.chat = live.chat; // guruh ko'chirilgan bo'lsa, yangi id yo'qolmasin
  if (live && live.stopped) return sent; // tick vaqtida «to'xtatish» bosilgan bo'lsa, qayta yoqib yubormaymiz
  await r().set(ST(), st);
  return sent;
}

export async function stopLowBackfill() {
  const st = await lowbfState();
  await r().del(Q());
  await r().del(OLD());
  if (st) await r().set(ST(), { ...st, done: true, stopped: true, pause_until: null });
}
