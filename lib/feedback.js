// "⭐ Mijoz fikri" — Telegram Business chatlari (@Mixpodarok0307, @Shtabfoto) uchun avtomatik baho so'rash.
// Xodim hech narsa bosmaydi: bot suhbatdan buyurtma tugaganini o'zi aniqlaydi (xodim «tayyor/olib keting» yozdi yoki
// tayyor ish rasmini/faylini yubordi, mijoz «rahmat/oldim» dedi), suhbat `delay_h` soat jim bo'lgach mijozga
// ⭐1–5 so'rovi boradi. 1–3⭐ va shikoyatlar — darrov guruhga; 4–5⭐ — Google/Yandex havolasi va (rozilik bilan) kanalga post.
// Rejim: off | watch (1-hafta: mijozga yozmaydi, faqat guruhga «so'rardim» deydi) | auto.
// settings.feedback = { mode, delay_h, cooldown_d, group, channel, biz: { [connId]: { on, name, google, yandex } } }
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';
import { REV_DEFAULTS } from './reviews.js';
import { igSign } from './ig.js';

export const MF_DEFAULTS = {
  mode: 'watch', delay_h: 3, file_delay_h: 24, cooldown_d: 30, group: '', channel: '', biz: {},
  slots: '12:00>14:00, 21:00>22:00', // ⏰ «qachongacha>qachon»: 12:00 gacha tugaganlar — 14:00 da, 21:00 gacha — 22:00 da, keyingilari — ertaga 14:00
  weekly_on: true, // 📅 har dushanba guruhga haftalik hisobot
  bonus_on: false, // 🎁 izoh qoldirganga chegirma kodi
  bonus_text: "🎁 Fikringiz uchun rahmat! Keyingi buyurtmangizda {kod} kodini ayting — 10% chegirma (30 kun amal qiladi).",
  card_on: true, // 🖼 5⭐ izohdan Instagram kartochkasi (guruhga)
  loyal_on: true, // 👑 sodiq mijozlar ro'yxati
};
const OLD_BONUS = "🎁 Fikringiz uchun rahmat! Keyingi buyurtmangizda {kod} kodini ayting — 5% chegirma.";
export const mfCfg = (s) => {
  const c = { ...MF_DEFAULTS, ...(s?.feedback || {}), biz: { ...(s?.feedback?.biz || {}) } };
  if (!c.bonus_text || c.bonus_text === OLD_BONUS) c.bonus_text = MF_DEFAULTS.bonus_text;
  if (c.slots === '14:00, 20:00') c.slots = MF_DEFAULTS.slots;
  return c;
};

const r = () => db.redis();
const CAND = () => db.K.flag('fb:cand'); // hash `${conn}:${chat}` -> nomzod
const REV = () => db.K.flag('fb:rev'); // hash id -> so'rov/baho yozuvi
const CUST = () => db.K.flag('fb:cust'); // hash `${conn}:${chat}` -> sodiq mijoz hisobi
const INV = () => db.K.flag('fb:inv'); // hash taklif havolasi -> so'rov id (kim qo'shilganini bilish)
const WAIT = (conn, chat) => db.K.flag(`fb:wait:${conn}:${chat}`); // mijozdan izoh kutilmoqda -> id

const DONE_STAFF = /(tayyor|олиб кет|olib ket|olib keting|tayyor bo'ldi|tayyor bo‘ldi|готов|забирайте|забрать|jo'natdik|jo‘natdik|yubordik|yetkazdik|отправили|доставили)/i;
const THANKS = /(rahmat|raxmat|раҳмат|рахмат|спасибо|spasibo|oldim|oldik|олдим|zo'r chiq|zor chiq|zo‘r chiq|juda yoqdi|yoqdi|chiroyli chiqibdi|отлично|супер|понравил)/i;
const COMPLAINT = /(yomon|sifatsiz|singan|sindi|buzil|kechik|kechikdi|shikoyat|noto'g'ri|noto‘g‘ri|xato qil|pulimni|qaytar|плохо|брак|сломан|не то|жалоб|опоздал|ужас|верните)/i;

const bc = (conn) => (conn ? { business_connection_id: conn } : {}); // bo'sh = bot o'zi (sinov)
// ⏰ yuborish jadvali: «12:00>14:00, 21:00>22:00» — [qachongacha tugagan, qachon yuboriladi] juftlari (Toshkent, UTC+5).
// «20:00» kabi yolg'iz vaqt = o'sha vaqtgacha tugaganlar o'sha vaqtda.
const TZ_MS = 5 * 3600000;
const hm = (x) => { const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(x).trim()); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null; };
export function parseSlots(v) {
  return String(v || '')
    .split(/[,;]+/)
    .map((p) => p.split(/\s*(?:>|→|-)\s*/).map(hm))
    .map((p) => (p.length >= 2 && p[0] != null && p[1] != null ? { cut: p[0], at: p[1] } : p[0] != null ? { cut: p[0], at: p[0] } : null))
    .filter(Boolean)
    .sort((a, b) => a.cut - b.cut);
}
export const fmtSlots = (v) => parseSlots(v).map((p) => { const f = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; return p.cut === p.at ? f(p.at) : `${f(p.cut)}>${f(p.at)}`; }).join(', ');
// t vaqtda tugagan buyurtma uchun so'rov vaqti
export function slotDue(cfg, t) {
  const sl = parseSlots(cfg.slots);
  if (!sl.length) return null;
  const loc = t + TZ_MS;
  const day0 = loc - (loc % 86400000); // mahalliy yarim tun (UTC+5 ko'rinishida)
  const min = Math.floor((loc % 86400000) / 60000);
  const p = sl.find((x) => min < x.cut);
  const at = p ? day0 + p.at * 60000 : day0 + 86400000 + sl[0].at * 60000;
  return Math.max(at - TZ_MS, t);
}
const tzHour = (now) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date(now))) % 24;
const stars = (n) => '⭐'.repeat(Math.max(0, Math.min(5, n)));
const who = (c) => [c.name, c.username ? `@${c.username}` : ''].filter(Boolean).join(' ') || `id ${c.chatId}`;
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]);

async function bizName(connId, cfg) {
  if (cfg.biz?.[connId]?.name) return cfg.biz[connId].name;
  const b = (await db.listBiz().catch(() => [])).find((x) => x.id === connId);
  return b?.user?.username ? `@${b.user.username}` : b?.user?.first_name || 'Biznes';
}
const groupOf = (cfg, s) => String(cfg.group || s.order_group || s.stock_group || '');
async function toGroup(cfg, s, text, extra = {}) {
  const chat = groupOf(cfg, s);
  if (!chat) return null;
  return tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch((e) => console.error(`fb group: ${errText(e)}`));
}

// handleBusinessMessage boshida chaqiriladi. true qaytsa — xabar izoh sifatida olindi (AI javob bermasin).
export async function mfObserve(msg, biz) {
  const s = await db.getSettings();
  const cfg = mfCfg(s);
  if (!db.hasRedis()) return false;
  const conn = msg.business_connection_id;
  const chatId = msg.chat?.id;
  if (!conn || !chatId) return false;
  if (msg.sender_business_bot || msg.is_from_offline) return false; // botning o'z xabarlari / avtomatik javoblar
  const text = String(msg.text || msg.caption || '');
  const staff = biz?.user && String(msg.from?.id) === String(biz.user.id);
  const field = `${conn}:${chatId}`;
  const now = Date.now();
  // /f va /x — rejim yoki profil o'chiq bo'lsa ham ishlaydi (xodim o'zi so'radi)
  const isCmd = staff && /^\/(f|x)(?:@\w+)?\s*$/i.test(text.trim());
  if (!isCmd && (cfg.mode === 'off' || cfg.biz?.[conn]?.on === false)) return false;

  // ⌨️ xodim buyrug'i mijoz chatida: /f — baho so'rovi darrov, /x — faqat xarita + guruh (bahosiz). Buyruq o'chiriladi.
  const cmd = staff ? /^\/(f|x)(?:@\w+)?\s*$/i.exec(text.trim()) : null;
  if (!staff && /^\/(f|x)\s*$/i.test(text.trim())) console.log(`fb cmd: ${text.trim()} — egasi emas (from ${msg.from?.id}, biz ${biz?.user?.id || '?'})`);
  if (cmd) {
    console.log(`fb cmd: /${cmd[1]} chat ${chatId}`);
    await tg('deleteBusinessMessages', { business_connection_id: conn, message_ids: [msg.message_id] }).catch(() => {});
    const c = { conn, chatId, name: msg.chat.first_name || '', username: msg.chat.username || '', reason: `xodim: /${cmd[1].toLowerCase()}` };
    await r().hdel(CAND(), field).catch(() => {});
    const res = cmd[1].toLowerCase() === 'f' ? await askNow(c, s, cfg) : await mapsNow(c, s, cfg);
    console.log(`fb cmd result: ${res.ok ? 'ok' : res.message}`);
    if (!res.ok && biz?.user?.id) await tg('sendMessage', { chat_id: biz.user.id, text: res.message }).catch(() => {});
    return true;
  }

  if (!staff) {
    // 1) so'rovdan keyin mijozning izohi
    const waitId = text ? await r().get(WAIT(conn, chatId)).catch(() => null) : null;
    if (waitId) {
      await r().del(WAIT(conn, chatId));
      await onComment(String(waitId), text, s, cfg);
      return true;
    }
    // 2) shikoyat — darrov guruhga (chat bo'yicha 6 soatda 1 marta), shu suhbatga so'rov yuborilmaydi
    if (COMPLAINT.test(text)) {
      const c = (await r().hget(CAND(), field).catch(() => null)) || {};
      await r().hset(CAND(), { [field]: { ...c, conn, chatId, name: msg.chat.first_name || '', username: msg.chat.username || '', complaint: true, last: now, due: 0 } });
      if (await db.once(`fb:cmpl:${field}`, 6 * 3600)) {
        await toGroup(cfg, s, `🚨 <b>Mijoz norozi</b> (${esc(await bizName(conn, cfg))})\n👤 ${esc(who({ name: msg.chat.first_name, username: msg.chat.username, chatId }))}\n💬 «${esc(text.slice(0, 500))}»\n\nMijozga tezroq javob bering.`);
      }
      return false;
    }
  }
  const c = await r().hget(CAND(), field).catch(() => null);
  let reason = null;
  if (staff && (DONE_STAFF.test(text) || msg.photo || msg.document || msg.video)) reason = DONE_STAFF.test(text) ? 'xodim: tayyor' : 'xodim: tayyor ish fayli';
  if (!staff && THANKS.test(text)) reason = 'mijoz: rahmat/oldim';
  // ishlab chiqarish (Shtabfoto): mijoz rasm/fayl yubordi = buyurtma berdi. Xodim «tayyor» demasa ham, file_delay_h soat
  // jimlikdan keyin buyurtma topshirilgan deb hisoblanadi
  const fileOrder = !staff && !reason && (msg.photo || msg.document || msg.video) && cfg.biz?.[conn]?.files_order === true;
  if (fileOrder) reason = 'mijoz: fayl/rasm yubordi (buyurtma)';
  if (!reason && !c) return false;
  if (c?.complaint && now - Number(c.last || 0) < 3 * 86400000) {
    await r().hset(CAND(), { [field]: { ...c, last: now } });
    return false;
  }
  // suhbat davom etsa muddat suriladi: oxirgi xabardan delay_h soat jimlikdan keyin so'raladi
  // qaysi kutish: xodim «tayyor» / mijoz «rahmat» — qisqa (delay_h); faqat fayl-buyurtma bo'lsa — uzun (file_delay_h)
  const kind = reason && !fileOrder ? 'done' : fileOrder ? (c?.kind === 'done' ? 'done' : 'file') : c?.kind || 'done';
  // jadval bo'lsa: «tayyor/rahmat» — shu paytdan; faqat fayl — file_delay_h soatdan keyin, eng yaqin yuborish vaqtiga
  const base = kind === 'file' ? now + cfg.file_delay_h * 3600000 : now;
  const sd = slotDue(cfg, base);
  const wait = (sd ?? now + (kind === 'file' ? cfg.file_delay_h : cfg.delay_h) * 3600000) - now;
  const rec = { ...(c || {}), conn, chatId, name: c?.name || msg.chat.first_name || '', username: c?.username || msg.chat.username || '', reason: kind === 'done' && reason && !fileOrder ? reason : c?.reason || reason, kind, first: c?.first || now, last: now, due: now + wait, complaint: false };
  await r().hset(CAND(), { [field]: rec });
  return false;
}

// biznes nomi: «@SHTABFOTO» -> «Shtabfoto» (katta harf va @ siz, qo'shimchasiz ishlatiladi)
const niceName = (n) => {
  const t = String(n || '').replace(/^@+/, '').trim();
  return t && t === t.toUpperCase() && /[A-Z]/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t || 'bizning';
};
const custName = (c) => String(c.name || '').trim() || (c.username ? `@${c.username}` : '');
const askText = (c, bname) => `Assalomu alaykum${custName(c) ? `, ${custName(c)}` : ''}! 😊\n${niceName(bname)} xizmatini tanlaganingiz uchun rahmat.\n\nXizmatimizni yaxshilash uchun fikringiz biz uchun muhim. Ishimizni qanday baholaysiz?`;

// /f: so'rovni hozir yuborish (jadval va 30 kunlik cheklovsiz)
async function askNow(c, s, cfg) {
  const bname = await bizName(c.conn, cfg);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const sent = await tg('sendMessage', { business_connection_id: c.conn, chat_id: c.chatId, text: askText(c, bname), reply_markup: rateKb(id) }).catch((e) => ({ err: errText(e) }));
  if (!sent || sent.err) return { ok: false, message: `❌ /f yuborilmadi: ${sent?.err || 'xato'}` };
  await db.once(`fb:asked:${c.conn}:${c.chatId}`, cfg.cooldown_d * 86400).catch(() => {});
  await r().hset(REV(), { [id]: { id, conn: c.conn, chatId: c.chatId, name: c.name, username: c.username, biz: bname, reason: c.reason, asked_at: Date.now(), msg: sent.message_id, manual: 'f' } });
  await db.incrStat('fb_asked').catch(() => {});
  return { ok: true };
}

// /x: xursand mijozga — xarita havolalari (tepada) va guruh (pastda), bitta xabarda. 30 kunda 1 marta.
async function mapsNow(c, s, cfg) {
  const xKey = db.K.flag(`fb:x2:${c.conn}:${c.chatId}`);
  if (await r().get(xKey).catch(() => null)) return { ok: false, message: `ℹ️ /x: ${custName(c) || 'bu mijoz'}ga xarita havolasi 30 kun ichida allaqachon yuborilgan — qayta yuborilmadi.` };
  const bname = await bizName(c.conn, cfg);
  const id = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const v = { id, conn: c.conn, chatId: c.chatId, name: c.name, username: c.username, biz: bname, reason: c.reason, asked_at: Date.now(), manual: 'x' };
  const maps = mapRows(v, cfg);
  const link = (await personalLink(v, cfg)) || chanUrl(v, cfg);
  if (!maps.length && !link) return { ok: false, message: "❌ /x: bu profil uchun Yandex/Google havolasi ham, guruh ham kiritilmagan (dashboard → 💬 Mijoz fikri)." };
  const rows = [...maps, ...(link ? [[{ text: "📢 Guruhimizga qo'shiling", url: link }]] : [])];
  const text = `Rahmat! 😊${maps.length ? "\nXaritada baho qoldirsangiz, boshqalarga yordam bo'ladi 🙏" : ''}`;
  const sent = await tg('sendMessage', { business_connection_id: c.conn, chat_id: c.chatId, text, reply_markup: { inline_keyboard: rows } }).catch((e) => ({ err: errText(e) }));
  if (!sent || sent.err) return { ok: false, message: `❌ /x yuborilmadi: ${sent?.err || 'xato'}` };
  await r().set(xKey, 1, { ex: 30 * 86400 }); // faqat muvaffaqiyatli yuborilgandan keyin
  await r().hset(REV(), { [id]: { ...v, msg: sent.message_id, links_at: Date.now(), group_at: link ? Date.now() : null } });
  await db.incrStat('fb_x').catch(() => {});
  return { ok: true };
}

function rateKb(id) {
  return { inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: `${n}⭐`, callback_data: `mf:r:${id}:${n}` }))] };
}

// cron tick: muddati kelgan nomzodlarga so'rov (watch rejimida — guruhga «so'rardim»)
export async function mfTick(s, now = Date.now(), { max = 15 } = {}) {
  const cfg = mfCfg(s);
  if (cfg.mode === 'off' || !db.hasRedis()) return null;
  const h = tzHour(now);
  const all = parseSlots(cfg.slots).length || (h >= 9 && h < 21) ? (await r().hgetall(CAND())) || {} : {};
  let n = 0;
  for (const [field, c] of Object.entries(all)) {
    if (!c || typeof c !== 'object') continue;
    if (now - Number(c.last || 0) > 7 * 86400000) { await r().hdel(CAND(), field); continue; } // eskirgan
    if (c.complaint || !c.due || c.due > now) continue;
    if (n >= max) break;
    await r().hdel(CAND(), field);
    if (cfg.biz?.[c.conn]?.on === false) continue;
    if (cfg.loyal_on) await bumpCust(c, { order: true }).catch(() => {});
    // doimiy mijoz: 4–5⭐ bergan bo'lsa 90 kun so'ralmaydi; aks holda cooldown_d kunda 1 marta
    if (await r().get(db.K.flag(`fb:good:${c.conn}:${c.chatId}`)).catch(() => null)) continue;
    if (!(await db.once(`fb:asked:${c.conn}:${c.chatId}`, cfg.cooldown_d * 86400))) continue;
    n++;
    const bname = await bizName(c.conn, cfg);
    if (cfg.mode === 'watch') {
      await toGroup(cfg, s, `🔍 <b>Kuzatuv rejimi</b> (${esc(bname)})\nBuyurtma tugadi deb o'ylayman — mijozga baho so'rovi yuborardim:\n👤 ${esc(who(c))}\n📌 Sabab: ${esc(c.reason)}\n\nTo'g'ri aniqlayotgan bo'lsa, dashboard → Statistika → «Mijoz fikri» da rejimni «Avtomatik» qiling.`);
      await db.incrStat('fb_watch').catch(() => {});
      continue;
    }
    const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const text = askText(c, bname);
    const sent = await tg('sendMessage', { ...bc(c.conn), chat_id: c.chatId, text, reply_markup: rateKb(id) }).catch((e) => {
      console.error(`fb ask: ${errText(e)}`);
      return null;
    });
    if (!sent) continue;
    await r().hset(REV(), { [id]: { id, conn: c.conn, chatId: c.chatId, name: c.name, username: c.username, biz: bname, reason: c.reason, asked_at: now, msg: sent.message_id } });
    await db.incrStat('fb_asked').catch(() => {});
  }
  for (const v of Object.values((await r().hgetall(REV())) || {})) {
    if (h >= 9 && h < 23 && v && v.rating >= 4 && v.group_due && !v.group_at && v.group_due <= now && now - v.group_due < 3 * 86400000) await sendGroupInvite(v, cfg).catch(() => {});
  }
  if (cfg.weekly_on) await weeklyReport(s, cfg, now).catch((e) => console.error(`fb weekly: ${errText(e)}`));
  return { asked: n };
}

// 👑 sodiq mijozlar: tugagan buyurtmalar va baholar soni
async function bumpCust(c, { order = false, rating = 0 } = {}) {
  const field = `${c.conn}:${c.chatId}`;
  const cur = (await r().hget(CUST(), field)) || {};
  const nx = { ...cur, conn: c.conn, chatId: c.chatId, name: c.name || cur.name || '', username: c.username || cur.username || '', biz: c.biz || cur.biz || '', orders: (cur.orders || 0) + (order ? 1 : 0), rsum: (cur.rsum || 0) + rating, rcnt: (cur.rcnt || 0) + (rating ? 1 : 0), last: Date.now(), first: cur.first || Date.now() };
  await r().hset(CUST(), { [field]: nx });
}
const isLoyal = (c) => c.orders >= 3 || (c.rcnt >= 2 && c.rsum / c.rcnt >= 4.5);

// 📅 har dushanba (09:00 dan keyin) o'tgan 7 kun bo'yicha qisqa hisobot
async function weeklyReport(s, cfg, now) {
  const wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', weekday: 'short' }).format(new Date(now));
  if (wd !== 'Mon' || tzHour(now) < 9) return;
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(now));
  if (!(await db.once(`fb:weekly:${ymd}`, 3 * 86400))) return;
  const since = now - 7 * 86400000;
  const revs = Object.values((await r().hgetall(REV())) || {}).filter((v) => v && typeof v === 'object' && !v.test && v.asked_at >= since);
  const rated = revs.filter((v) => v.rating);
  const avg = rated.length ? (rated.reduce((a, v) => a + v.rating, 0) / rated.length).toFixed(1) : '—';
  const low = rated.filter((v) => v.rating <= 3);
  const best = rated.filter((v) => v.rating === 5 && v.comment).sort((a, b) => b.comment.length - a.comment.length)[0];
  const text = `📅 <b>Haftalik hisobot — mijoz fikri</b>\n\n📨 So'ralgan: ${revs.length}\n⭐ Baho berganlar: ${rated.length}${revs.length ? ` (${Math.round((rated.length / revs.length) * 100)}%)` : ''}\n📊 O'rtacha: <b>${avg}</b>\n⚠️ Past baho (1–3⭐): ${low.length}${low.length ? ` · hal qilingan: ${low.filter((v) => v.resolved_at).length}` : ''}${best ? `\n\n💬 Eng yaxshi izoh:\n«${esc(best.comment.slice(0, 300))}» — ${esc(String(best.name || '').split(/\s+/)[0] || 'mijoz')}` : ''}`;
  await toGroup(cfg, s, text);
}

// 🖼 Instagram kartochkasi (1080×1080): /api/mfcard?d=..&s=..
const baseUrl = () => `https://${process.env.IG_IMG_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
export function mfCardUrl(id) {
  const d = Buffer.from(JSON.stringify({ k: 'mf', id })).toString('base64url');
  return `${baseUrl()}/api/mfcard?d=${d}&s=${igSign(d)}`;
}
export async function mfCardSend(id, s, cfg) {
  const v = await r().hget(REV(), id);
  if (!v?.comment) return { ok: false, message: "❌ Izoh yo'q" };
  const chat = groupOf(cfg, s);
  if (!chat) return { ok: false, message: '❌ Signal guruhi tanlanmagan' };
  await tg('sendPhoto', { chat_id: chat, photo: `${mfCardUrl(id)}&t=${Date.now()}`, caption: `🖼 Instagram uchun tayyor kartochka (${stars(v.rating)}, ${v.biz}). Rasmni saqlab, joylashingiz mumkin.` });
  await r().hset(REV(), { [id]: { ...v, card_at: Date.now() } });
  return { ok: true, message: '🖼 Kartochka guruhga yuborildi' };
}
export async function mfRecord(id) {
  return r().hget(REV(), id);
}

function mapRows(v, cfg) {
  const b = cfg.biz?.[v.conn || v.linkConn] || {};
  const google = b.google || (/(mixpodarok)/i.test(v.biz) ? REV_DEFAULTS.google : '');
  const yandex = b.yandex || (/(mixpodarok)/i.test(v.biz) ? REV_DEFAULTS.yandex : '');
  const row = [...(yandex ? [{ text: '⭐ Yandex', url: yandex }] : []), ...(google ? [{ text: '⭐ Google', url: google }] : [])];
  return row.length ? [row] : [];
}
// 📢 shaxsiy taklif havolasi: 1 kishilik, mijoz ismi bilan, 30 kun. Bot guruh/kanalda admin («Invite users via link») bo'lsa
// ishlaydi; aks holda umumiy havola. Qo'shilganini chat_member yangilanishidan bilamiz (mfChatMember).
function chanChat(v, cfg) {
  const c = String(cfg.biz?.[v.conn || v.linkConn]?.channel || '').trim();
  if (/^-100\d+$/.test(c)) return c;
  const u = c.replace(/^https?:\/\/t\.me\//i, '').replace(/^t\.me\//i, '').replace(/^@/, '');
  return /^[A-Za-z0-9_]{4,}$/.test(u) ? `@${u}` : '';
}
async function personalLink(v, cfg) {
  const chat = chanChat(v, cfg);
  if (!chat) return '';
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit' }).format(new Date());
  const name = `${custName(v) || 'Mijoz'} · ${day}`.slice(0, 32);
  const l = await tg('createChatInviteLink', { chat_id: chat, name, member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 30 * 86400 }).catch((e) => {
    console.error(`fb invite: ${errText(e)}`);
    return null;
  });
  if (!l?.invite_link) return '';
  await r().hset(INV(), { [l.invite_link]: v.id });
  return l.invite_link;
}

// 📢 guruhga taklif (bitta tugma). Bonus kodi bo'lsa — o'sha xabar ichida («aksiya» bilan mantiqan bog'liq)
async function sendGroupInvite(v, cfg, bonusText = '') {
  if (v.group_at) return;
  await r().hset(REV(), { [v.id]: { ...v, group_at: Date.now() } }); // ikki marta ketmasin
  const link = (await personalLink(v, cfg)) || chanUrl(v, cfg);
  if (!link) {
    if (bonusText) await tg('sendMessage', { ...bc(v.conn), chat_id: v.chatId, text: bonusText }).catch(() => {});
    return;
  }
  const text = bonusText
    ? `${bonusText}\n\n📢 Yangi aksiyalarni o'tkazib yubormaslik uchun guruhimizga qo'shiling.`
    : "🎁 Aytgancha, guruhimizda yangi ishlarimiz va aksiyalar bo'ladi.";
  await tg('sendMessage', { ...bc(v.conn), chat_id: v.chatId, text, reply_markup: { inline_keyboard: [[{ text: "📢 Guruhga qo'shilish", url: link }]] } }).catch((e) => console.error(`fb group invite: ${errText(e)}`));
}

// guruh/kanal a'zoligi o'zgardi: shaxsiy havola bilan qo'shilgan bo'lsa — belgilaymiz
export async function mfChatMember(u) {
  const link = u?.invite_link?.invite_link;
  const st = u?.new_chat_member?.status;
  if (!link || !['member', 'restricted', 'administrator'].includes(st)) return false;
  const id = await r().hget(INV(), link).catch(() => null);
  if (!id) return false;
  const v = await r().hget(REV(), String(id));
  if (!v || v.joined_at) return true;
  await r().hset(REV(), { [v.id]: { ...v, joined_at: Date.now() } });
  if (!v.test) {
    const field = `${v.conn}:${v.chatId}`;
    const c = await r().hget(CUST(), field).catch(() => null);
    if (c) await r().hset(CUST(), { [field]: { ...c, joined_at: Date.now() } });
  }
  await db.incrStat('fb_joined').catch(() => {});
  return true;
}

// 📢 4–5⭐ dan keyin: profilning Telegram kanaliga obuna tugmasi (eng pastda)
function chanUrl(v, cfg) {
  const c = String(cfg.biz?.[v.conn || v.linkConn]?.channel || '').trim();
  if (!c) return '';
  if (/^https?:\/\//i.test(c)) return c;
  const u = c.replace(/^@/, '').replace(/^t\.me\//i, '');
  return /^[A-Za-z0-9_]{4,}$/.test(u) ? `https://t.me/${u}` : '';
}
const writeBtn = (id) => [{ text: '✍️ Fikr qoldirish', callback_data: `mf:w:${id}` }];

async function sendThanks(v, s, cfg, { consent = true } = {}) {
  const b = cfg.biz?.[v.conn || v.linkConn] || {};
  const google = b.google || (/(mixpodarok)/i.test(v.biz) ? REV_DEFAULTS.google : '');
  const yandex = b.yandex || (/(mixpodarok)/i.test(v.biz) ? REV_DEFAULTS.yandex : '');
  const rows = [...(yandex ? [[{ text: '⭐ Yandex Kartada baho', url: yandex }]] : []), ...(google ? [[{ text: '⭐ Google Kartada baho', url: google }]] : [])];
  const canPost = consent && cfg.channel && v.comment;
  if (canPost) rows.push([{ text: "✅ Ha, e'lon qiling", callback_data: `mf:c:${v.id}:y` }, { text: "❌ Yo'q", callback_data: `mf:c:${v.id}:n` }]);
  const text = `Juda xursandmiz! 🙏${rows.length && (yandex || google) ? "\nXaritada ham baho qoldirsangiz, boshqalarga yordam bo'ladi." : ''}${canPost ? "\n\nFikringizni kanalimizda ismingiz bilan e'lon qilsak bo'ladimi?" : ''}`;
  await tg('sendMessage', { ...bc(v.conn), chat_id: v.chatId, text, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) }).catch((e) => console.error(`fb thanks: ${errText(e)}`));
  await r().hset(REV(), { [v.id]: { ...v, links_at: Date.now() } });
}

async function onComment(id, text, s, cfg) {
  const v = await r().hget(REV(), id);
  if (!v) return;
  let nv = { ...v, comment: text.slice(0, 1000), comment_at: Date.now() };
  if (cfg.bonus_on && !v.bonus) nv = { ...nv, bonus: `F${Math.random().toString(36).slice(2, 7).toUpperCase()}` };
  await r().hset(REV(), { [id]: nv });
  if (nv.rating <= 3) {
    await toGroup(cfg, s, `⚠️ <b>Past baho: ${stars(nv.rating)}</b> (${esc(nv.biz)})\n👤 ${esc(who(nv))}\n💬 «${esc(nv.comment)}»`, { reply_markup: { inline_keyboard: [[{ text: '✅ Hal qilindi', callback_data: `mf:ok:${id}` }]] } });
    await tg('sendMessage', { ...bc(nv.conn), chat_id: nv.chatId, text: "Rahmat, fikringizni menejerimizga yetkazdik. Tez orada bog'lanamiz 🙏" }).catch(() => {});
  } else {
    await tg('sendMessage', { ...bc(nv.conn), chat_id: nv.chatId, text: 'Fikringiz uchun katta rahmat! 🙏 Sizni yana kutib qolamiz.' }).catch(() => {});
    // 👏 yaxshi izoh ham xodimlar guruhiga (motivatsiya)
    await toGroup(cfg, s, `✅ <b>Yangi fikr: ${stars(nv.rating)}</b> (${esc(nv.biz)})\n👤 ${esc(who(nv))}\n💬 «${esc(nv.comment)}»`);
    if (cfg.card_on && nv.rating === 5 && nv.comment.length >= 15) await mfCardSend(id, s, cfg).catch((e) => console.error(`fb card: ${errText(e)}`));
  }
  const bonusText = nv.bonus && !v.bonus ? String(cfg.bonus_text || MF_DEFAULTS.bonus_text).replace(/\{kod\}/g, nv.bonus) : '';
  if (nv.rating >= 4) await sendGroupInvite(nv, cfg, bonusText);
  else if (bonusText) await tg('sendMessage', { ...bc(nv.conn), chat_id: nv.chatId, text: bonusText }).catch(() => {});
}

// callback: mf:r:<id>:<n> (mijoz baho bosdi), mf:c:<id>:y|n (kanal roziligi), mf:ok:<id> (guruhda «hal qilindi»)
export async function mfCallback(cb) {
  const [, kind, id, val] = String(cb.data || '').split(':');
  const ans = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const s = await db.getSettings();
  const cfg = mfCfg(s);
  const v = await r().hget(REV(), id);
  if (!v) return ans('Eskirgan');
  if (kind === 'r') {
    if (v.rating) return ans('Rahmat, bahongiz qabul qilingan');
    const n = Math.max(1, Math.min(5, Number(val) || 0));
    const nv = { ...v, rating: n, rated_at: Date.now() };
    await r().hset(REV(), { [id]: nv });
    if (n >= 4) await r().set(db.K.flag(`fb:good:${v.conn}:${v.chatId}`), 1, { ex: 90 * 86400 }).catch(() => {});
    if (cfg.loyal_on && !v.test) await bumpCust(v, { rating: n }).catch(() => {});
    await ans(stars(n));
    await tg('editMessageReplyMarkup', { ...bc(v.conn), chat_id: v.chatId, message_id: v.msg, reply_markup: { inline_keyboard: [[{ text: `Bahongiz: ${stars(n)}`, callback_data: 'mf:x' }]] } }).catch(() => {});
    await r().set(WAIT(v.conn, v.chatId), id, { ex: 6 * 3600 });
    const maps = n >= 4 ? mapRows(v, cfg) : [];
    const rows = n <= 3 ? [writeBtn(id)] : [writeBtn(id), ...maps];
    await tg('sendMessage', {
      ...bc(v.conn),
      chat_id: v.chatId,
      text: n <= 3 ? "Uzr so'raymiz 😔 Nima yoqmadi? Fikringizni qoldiring — albatta to'g'rilaymiz." : `Rahmat, juda xursandmiz! 😊${maps.length ? "\nXaritada baho qoldirsangiz, boshqalarga yordam bo'ladi 🙏" : ''}`,
      reply_markup: { inline_keyboard: rows },
    }).catch(() => {});
    // 📢 guruh taklifi alohida: izoh yozilgach yoki ~10–20 daqiqadan keyin (mfTick)
    if (n >= 4) await r().hset(REV(), { [id]: { ...nv, links_at: Date.now(), group_due: chanChat(v, cfg) || chanUrl(v, cfg) ? Date.now() + 10 * 60000 : 0 } });
    if (n <= 3) await toGroup(cfg, s, `⚠️ <b>Past baho: ${stars(n)}</b> (${esc(v.biz)})\n👤 ${esc(who(v))}\nIzoh kutilmoqda…`);
    await db.incrStat('fb_rated').catch(() => {});
    return null;
  }
  if (kind === 'w') {
    if (v.comment) return ans('Fikringiz qabul qilingan, rahmat!');
    await r().set(WAIT(v.conn, v.chatId), id, { ex: 6 * 3600 });
    await ans();
    await tg('sendMessage', { ...bc(v.conn), chat_id: v.chatId, text: '✍️ Fikringizni shu yerga yozib yuboring 👇' }).catch(() => {});
    return null;
  }
  if (kind === 'c') {
    const yes = val === 'y';
    await r().hset(REV(), { [id]: { ...v, consent: yes } });
    await ans(yes ? 'Rahmat!' : 'Tushunarli');
    await tg('editMessageReplyMarkup', { ...bc(v.conn), chat_id: v.chatId, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (yes && cfg.channel && v.comment && !v.posted_at) {
      const nm = String(v.name || '').split(/\s+/)[0] || 'Mijozimiz';
      await tg('sendMessage', { chat_id: cfg.channel, text: `💬 <b>Mijozlarimiz fikri</b> ${stars(v.rating)}\n\n«${esc(v.comment)}»\n\n— ${esc(nm)}`, parse_mode: 'HTML' }).catch((e) => console.error(`fb post: ${errText(e)}`));
      await r().hset(REV(), { [id]: { ...v, consent: yes, posted_at: Date.now() } });
    }
    return null;
  }
  if (kind === 'ok') {
    await r().hset(REV(), { [id]: { ...v, resolved_at: Date.now() } });
    await ans('Belgilandi');
    await tg('editMessageReplyMarkup', { chat_id: cb.message?.chat.id, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [[{ text: '✅ Hal qilingan', callback_data: 'mf:x' }]] } }).catch(() => {});
    return null;
  }
  return ans();
}

export async function mfView(s) {
  const cfg = mfCfg(s);
  const revs = Object.values((await r().hgetall(REV()).catch(() => null)) || {}).filter((v) => v && typeof v === 'object' && !v.test);
  const since = Date.now() - 30 * 86400000;
  const m = revs.filter((v) => v.asked_at >= since && v.manual !== 'x');
  const xs = revs.filter((v) => v.asked_at >= since && v.manual === 'x').length;
  const rated = m.filter((v) => v.rating);
  const avg = rated.length ? Math.round((rated.reduce((a, v) => a + v.rating, 0) / rated.length) * 10) / 10 : null;
  const open = revs.filter((v) => v.rating && v.rating <= 3 && !v.resolved_at).length;
  const good = rated.filter((v) => v.rating >= 4);
  const joined = good.filter((v) => v.joined_at).length;
  const cand = Object.keys((await r().hgetall(CAND()).catch(() => null)) || {}).length;
  const bizList = (await db.listBiz().catch(() => [])).map((b) => ({ id: b.id, label: b.user?.username ? `@${b.user.username}` : b.user?.first_name || b.id, ...(cfg.biz?.[b.id] || {}) }));
  const list = revs.sort((a, b) => b.asked_at - a.asked_at).slice(0, 40).map((v) => ({ id: v.id, biz: v.biz, who: who(v), rating: v.rating || 0, comment: v.comment || '', at: v.asked_at, open: Boolean(v.rating && v.rating <= 3 && !v.resolved_at), bonus: v.bonus || '', card: Boolean(v.card_at), joined: Boolean(v.joined_at), manual: v.manual || '' }));
  const loyal = cfg.loyal_on
    ? Object.values((await r().hgetall(CUST()).catch(() => null)) || {}).filter((c) => c && typeof c === 'object' && isLoyal(c)).sort((a, b) => b.orders - a.orders || b.last - a.last).slice(0, 50).map((c) => ({ who: who(c), biz: c.biz, orders: c.orders || 0, avg: c.rcnt ? Math.round((c.rsum / c.rcnt) * 10) / 10 : null, last: c.last, joined: Boolean(c.joined_at) }))
    : [];
  return { ok: true, cfg: { ...cfg, biz: undefined }, biz: bizList, stats: { asked: m.length, rated: rated.length, avg, rate: m.length ? Math.round((rated.length / m.length) * 100) : 0, open, cand, joined, joinRate: good.length ? Math.round((joined / good.length) * 100) : 0, xs }, list, loyal };
}

export async function mfSetCfg(body = {}) {
  const s = await db.getSettings();
  const cur = mfCfg(s);
  const mode = ['off', 'watch', 'auto'].includes(body.mode) ? body.mode : cur.mode;
  const num = (x, lo, hi, d) => (Number.isFinite(Number(x)) ? Math.max(lo, Math.min(hi, Math.round(Number(x)))) : d);
  const url = (x) => (/^https?:\/\/\S+$/i.test(String(x || '').trim()) ? String(x).trim() : '');
  const biz = { ...cur.biz };
  for (const b of Array.isArray(body.biz) ? body.biz : []) {
    if (!b?.id) continue;
    biz[b.id] = { on: b.on !== false, files_order: b.files_order === true, name: String(b.name || '').slice(0, 60), google: url(b.google), yandex: url(b.yandex), channel: String(b.channel || '').trim().slice(0, 120) };
  }
  const next = { mode, slots: body.slots === undefined ? cur.slots : fmtSlots(body.slots), delay_h: num(body.delay_h, 1, 48, cur.delay_h), file_delay_h: num(body.file_delay_h, 2, 168, cur.file_delay_h), cooldown_d: num(body.cooldown_d, 7, 180, cur.cooldown_d), group: String(body.group ?? cur.group).trim(), channel: String(body.channel ?? cur.channel).trim(), biz,
    weekly_on: body.weekly_on === undefined ? cur.weekly_on : Boolean(body.weekly_on),
    bonus_on: body.bonus_on === undefined ? cur.bonus_on : Boolean(body.bonus_on),
    bonus_text: String(body.bonus_text ?? cur.bonus_text).slice(0, 500) || MF_DEFAULTS.bonus_text,
    card_on: body.card_on === undefined ? cur.card_on : Boolean(body.card_on),
    loyal_on: body.loyal_on === undefined ? cur.loyal_on : Boolean(body.loyal_on) };
  await db.updateSettings({ feedback: next });
  return { ok: true, message: `💾 Saqlandi · rejim: ${{ off: "o'chiq", watch: 'kuzatuv (mijozga yozilmaydi)', auto: 'avtomatik' }[mode]}` };
}

// 🧪 Sinov: so'rov egasiga bot chatidan keladi (Business'siz) — baho, izoh, havolalar, guruh signali haqiqiydek ishlaydi
export async function mfTest(chatId, connId = '') {
  if (!chatId) return { ok: false, message: "❌ Bot egasi aniqlanmadi — botga /start yozing" };
  const s = await db.getSettings();
  const cfg = mfCfg(s);
  const conn = connId || Object.keys(cfg.biz || {}).find((k) => cfg.biz[k]?.on !== false) || '';
  const bname = conn ? await bizName(conn, cfg) : 'Biznes';
  const id = `t${Date.now().toString(36)}`;
  const me = await tg('getChat', { chat_id: chatId }).catch(() => null);
  const sent = await tg('sendMessage', { chat_id: chatId, text: `🧪 SINOV\n\n${askText({ name: me?.first_name || '', username: me?.username || '' }, bname)}`, reply_markup: rateKb(id) });
  // conn = '' : javoblar bot chatiga boradi; havolalar uchun profil nomi saqlanadi
  await r().hset(REV(), { [id]: { id, conn: '', linkConn: conn, chatId, name: 'Sinov', username: '', biz: `🧪 sinov · ${bname}`, reason: 'sinov', asked_at: Date.now(), msg: sent?.message_id, test: true } });
  return { ok: true, message: "🧪 Sinov so'rovi Telegram'da bot chatiga yuborildi — baho bosing, izoh yozing" };
}

// bot bilan shaxsiy chatdagi xabar — sinov so'roviga izoh bo'lsa olinadi
export async function mfPrivateComment(msg) {
  if (msg.chat?.type !== 'private' || !msg.text || msg.text.startsWith('/')) return false;
  const waitId = await r().get(WAIT('', msg.chat.id)).catch(() => null);
  if (!waitId) return false;
  await r().del(WAIT('', msg.chat.id));
  const s = await db.getSettings();
  await onComment(String(waitId), msg.text, s, mfCfg(s));
  return true;
}
