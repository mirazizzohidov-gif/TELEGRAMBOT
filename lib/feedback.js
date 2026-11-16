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

export const MF_DEFAULTS = { mode: 'watch', delay_h: 3, file_delay_h: 24, cooldown_d: 30, group: '', channel: '', biz: {} };
export const mfCfg = (s) => ({ ...MF_DEFAULTS, ...(s?.feedback || {}), biz: { ...(s?.feedback?.biz || {}) } });

const r = () => db.redis();
const CAND = () => db.K.flag('fb:cand'); // hash `${conn}:${chat}` -> nomzod
const REV = () => db.K.flag('fb:rev'); // hash id -> so'rov/baho yozuvi
const WAIT = (conn, chat) => db.K.flag(`fb:wait:${conn}:${chat}`); // mijozdan izoh kutilmoqda -> id

const DONE_STAFF = /(tayyor|олиб кет|olib ket|olib keting|tayyor bo'ldi|tayyor bo‘ldi|готов|забирайте|забрать|jo'natdik|jo‘natdik|yubordik|yetkazdik|отправили|доставили)/i;
const THANKS = /(rahmat|raxmat|раҳмат|рахмат|спасибо|spasibo|oldim|oldik|олдим|zo'r chiq|zor chiq|zo‘r chiq|juda yoqdi|yoqdi|chiroyli chiqibdi|отлично|супер|понравил)/i;
const COMPLAINT = /(yomon|sifatsiz|singan|sindi|buzil|kechik|kechikdi|shikoyat|noto'g'ri|noto‘g‘ri|xato qil|pulimni|qaytar|плохо|брак|сломан|не то|жалоб|опоздал|ужас|верните)/i;

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
  if (cfg.mode === 'off' || !db.hasRedis()) return false;
  const conn = msg.business_connection_id;
  const chatId = msg.chat?.id;
  if (!conn || !chatId || cfg.biz?.[conn]?.on === false) return false;
  if (msg.sender_business_bot || msg.is_from_offline) return false; // botning o'z xabarlari / avtomatik javoblar
  const text = String(msg.text || msg.caption || '');
  const staff = biz?.user && String(msg.from?.id) === String(biz.user.id);
  const field = `${conn}:${chatId}`;
  const now = Date.now();

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
  const wait = (kind === 'file' ? cfg.file_delay_h : cfg.delay_h) * 3600000;
  const rec = { ...(c || {}), conn, chatId, name: c?.name || msg.chat.first_name || '', username: c?.username || msg.chat.username || '', reason: kind === 'done' && reason && !fileOrder ? reason : c?.reason || reason, kind, first: c?.first || now, last: now, due: now + wait, complaint: false };
  await r().hset(CAND(), { [field]: rec });
  return false;
}

function rateKb(id) {
  return { inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: `${n}⭐`, callback_data: `mf:r:${id}:${n}` }))] };
}

// cron tick: muddati kelgan nomzodlarga so'rov (watch rejimida — guruhga «so'rardim»)
export async function mfTick(s, now = Date.now(), { max = 15 } = {}) {
  const cfg = mfCfg(s);
  if (cfg.mode === 'off' || !db.hasRedis()) return null;
  const h = tzHour(now);
  if (h < 9 || h >= 21) return null;
  const all = (await r().hgetall(CAND())) || {};
  let n = 0;
  for (const [field, c] of Object.entries(all)) {
    if (!c || typeof c !== 'object') continue;
    if (now - Number(c.last || 0) > 7 * 86400000) { await r().hdel(CAND(), field); continue; } // eskirgan
    if (c.complaint || !c.due || c.due > now) continue;
    if (n >= max) break;
    await r().hdel(CAND(), field);
    if (cfg.biz?.[c.conn]?.on === false) continue;
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
    const text = `Assalomu alaykum${c.name ? `, ${c.name}` : ''}! 😊\n${bname}ni tanlaganingiz uchun rahmat.\n\nXizmatimizni yaxshilash uchun fikringiz biz uchun muhim. Ishimizni qanday baholaysiz?`;
    const sent = await tg('sendMessage', { business_connection_id: c.conn, chat_id: c.chatId, text, reply_markup: rateKb(id) }).catch((e) => {
      console.error(`fb ask: ${errText(e)}`);
      return null;
    });
    if (!sent) continue;
    await r().hset(REV(), { [id]: { id, conn: c.conn, chatId: c.chatId, name: c.name, username: c.username, biz: bname, reason: c.reason, asked_at: now, msg: sent.message_id } });
    await db.incrStat('fb_asked').catch(() => {});
  }
  // izoh yozmaganlar: 4–5⭐ bo'lsa havolalar baribir yuboriladi
  const revs = (await r().hgetall(REV())) || {};
  for (const v of Object.values(revs)) {
    if (v?.rating >= 4 && !v.links_at && !v.comment && now - Number(v.rated_at || 0) > 2 * 3600000) await sendThanks(v, s, cfg, { consent: false });
  }
  return { asked: n };
}

async function sendThanks(v, s, cfg, { consent = true } = {}) {
  const b = cfg.biz?.[v.conn] || {};
  const google = b.google || (/(mixpodarok)/i.test(v.biz) ? REV_DEFAULTS.google : '');
  const yandex = b.yandex || (/(mixpodarok)/i.test(v.biz) ? REV_DEFAULTS.yandex : '');
  const rows = [...(yandex ? [[{ text: '⭐ Yandex Kartada baho', url: yandex }]] : []), ...(google ? [[{ text: '⭐ Google Kartada baho', url: google }]] : [])];
  const canPost = consent && cfg.channel && v.comment;
  if (canPost) rows.push([{ text: "✅ Ha, e'lon qiling", callback_data: `mf:c:${v.id}:y` }, { text: "❌ Yo'q", callback_data: `mf:c:${v.id}:n` }]);
  const text = `Juda xursandmiz! 🙏${rows.length && (yandex || google) ? "\nXaritada ham baho qoldirsangiz, boshqalarga yordam bo'ladi." : ''}${canPost ? "\n\nFikringizni kanalimizda ismingiz bilan e'lon qilsak bo'ladimi?" : ''}`;
  await tg('sendMessage', { business_connection_id: v.conn, chat_id: v.chatId, text, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) }).catch((e) => console.error(`fb thanks: ${errText(e)}`));
  await r().hset(REV(), { [v.id]: { ...v, links_at: Date.now() } });
}

async function onComment(id, text, s, cfg) {
  const v = await r().hget(REV(), id);
  if (!v) return;
  const nv = { ...v, comment: text.slice(0, 1000), comment_at: Date.now() };
  await r().hset(REV(), { [id]: nv });
  if (nv.rating <= 3) {
    await toGroup(cfg, s, `⚠️ <b>Past baho: ${stars(nv.rating)}</b> (${esc(nv.biz)})\n👤 ${esc(who(nv))}\n💬 «${esc(nv.comment)}»`, { reply_markup: { inline_keyboard: [[{ text: '✅ Hal qilindi', callback_data: `mf:ok:${id}` }]] } });
    await tg('sendMessage', { business_connection_id: nv.conn, chat_id: nv.chatId, text: "Rahmat, fikringizni menejerimizga yetkazdik. Tez orada bog'lanamiz 🙏" }).catch(() => {});
  } else {
    await sendThanks(nv, s, cfg, { consent: true });
  }
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
    await ans(stars(n));
    await tg('editMessageReplyMarkup', { business_connection_id: v.conn, chat_id: v.chatId, message_id: v.msg, reply_markup: { inline_keyboard: [[{ text: `Bahongiz: ${stars(n)}`, callback_data: 'mf:x' }]] } }).catch(() => {});
    await r().set(WAIT(v.conn, v.chatId), id, { ex: 2 * 3600 });
    await tg('sendMessage', { business_connection_id: v.conn, chat_id: v.chatId, text: n <= 3 ? "Uzr so'raymiz 😔 Nima yoqmadi? Bir-ikki so'z bilan yozing — albatta to'g'rilaymiz." : 'Rahmat! 😊 Bir-ikki so\'z bilan fikringizni yozib qoldirasizmi?' }).catch(() => {});
    if (n <= 3) await toGroup(cfg, s, `⚠️ <b>Past baho: ${stars(n)}</b> (${esc(v.biz)})\n👤 ${esc(who(v))}\nIzoh kutilmoqda…`);
    await db.incrStat('fb_rated').catch(() => {});
    return null;
  }
  if (kind === 'c') {
    const yes = val === 'y';
    await r().hset(REV(), { [id]: { ...v, consent: yes } });
    await ans(yes ? 'Rahmat!' : 'Tushunarli');
    await tg('editMessageReplyMarkup', { business_connection_id: v.conn, chat_id: v.chatId, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
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
  const revs = Object.values((await r().hgetall(REV()).catch(() => null)) || {}).filter((v) => v && typeof v === 'object');
  const since = Date.now() - 30 * 86400000;
  const m = revs.filter((v) => v.asked_at >= since);
  const rated = m.filter((v) => v.rating);
  const avg = rated.length ? Math.round((rated.reduce((a, v) => a + v.rating, 0) / rated.length) * 10) / 10 : null;
  const open = revs.filter((v) => v.rating && v.rating <= 3 && !v.resolved_at).length;
  const cand = Object.keys((await r().hgetall(CAND()).catch(() => null)) || {}).length;
  const bizList = (await db.listBiz().catch(() => [])).map((b) => ({ id: b.id, label: b.user?.username ? `@${b.user.username}` : b.user?.first_name || b.id, ...(cfg.biz?.[b.id] || {}) }));
  const list = revs.sort((a, b) => b.asked_at - a.asked_at).slice(0, 40).map((v) => ({ biz: v.biz, who: who(v), rating: v.rating || 0, comment: v.comment || '', at: v.asked_at, open: Boolean(v.rating && v.rating <= 3 && !v.resolved_at), posted: Boolean(v.posted_at) }));
  return { ok: true, cfg: { ...cfg, biz: undefined }, biz: bizList, stats: { asked: m.length, rated: rated.length, avg, rate: m.length ? Math.round((rated.length / m.length) * 100) : 0, open, cand }, list };
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
    biz[b.id] = { on: b.on !== false, files_order: b.files_order === true, name: String(b.name || '').slice(0, 60), google: url(b.google), yandex: url(b.yandex) };
  }
  const next = { mode, delay_h: num(body.delay_h, 1, 48, cur.delay_h), file_delay_h: num(body.file_delay_h, 2, 168, cur.file_delay_h), cooldown_d: num(body.cooldown_d, 7, 180, cur.cooldown_d), group: String(body.group ?? cur.group).trim(), channel: String(body.channel ?? cur.channel).trim(), biz };
  await db.updateSettings({ feedback: next });
  return { ok: true, message: `💾 Saqlandi · rejim: ${{ off: "o'chiq", watch: 'kuzatuv (mijozga yozilmaydi)', auto: 'avtomatik' }[mode]}` };
}
