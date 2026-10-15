// "🛒 Buyurtma berish" inside the bot: the order button opens the bot (t.me/<bot>?start=o_<product_id>),
// the bot asks how many, the phone number and the address (or "🏪 O'zim olib ketaman"), shows a summary,
// and on "✅ Tasdiqlash" sends the order to the order group (or the admins) with "✅ Qabul qilindi" /
// "❌ Bekor qilish" buttons; the customer is told each step. Optionally (admin switch, test mode) a sale
// order is also created in BITO.

import { bitoPost, formatPrice, getProductById, imageUrl, loadDiscounts, priceFor, productImage, productStock } from './bito.js';
import { notifyAdmins } from './report.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

const DRAFT_TTL = 60 * 60 * 24;
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PHONE_RE = /^\+?\d[\d\s()-]{7,16}\d$/;
export const PICKUP = "🏪 O'zim olib ketaman";
export const CANCEL = '❌ Bekor qilish';

// Where the "🛒 Buyurtma berish" button leads: the bot itself (default) or the manager link.
export const orderLink = (s, item = null) =>
  s.order_in_bot !== false && s.bot_username ? `https://t.me/${s.bot_username}?start=${item?.product_id ? `o_${item.product_id}` : 'o'}` : s.order_url;
export const orderKb = (s, item = null) => ({ inline_keyboard: [[{ text: '🛒 Buyurtma berish', url: orderLink(s, item) }]] });

const draftKey = (uid) => `${db.K.flag('order')}:${uid}`;
export const getDraft = (uid) => db.redis().get(draftKey(uid));
const setDraft = (uid, d) => db.redis().set(draftKey(uid), d, { ex: DRAFT_TTL });
const dropDraft = (uid) => db.redis().del(draftKey(uid));

const removeKb = { remove_keyboard: true };

async function productInfo(pid) {
  const p = await getProductById(pid).catch(() => null);
  if (!p) return null;
  const pr = await priceFor(p, await loadDiscounts()).catch(() => ({ price: 0 }));
  return { pid: String(p._id), sku: String(p.sku), name: p.name, price: Number(pr.price) || 0, img: imageUrl(productImage(p)), stock: productStock(p), org: p.organizations?.[0]?.organization_id || null };
}

// /start o_<id> (or the order button in the bot's own chat): ask how many.
export async function startOrder(chatId, user, pid, s) {
  if (!pid) {
    return tg('sendMessage', { chat_id: chatId, text: "🛒 Qaysi mahsulotni buyurtma qilasiz? Nomini, SKU sini yozing yoki rasmini yuboring — kartochkadagi \"🛒 Buyurtma berish\" tugmasini bosing." });
  }
  const info = await productInfo(pid);
  if (!info) return tg('sendMessage', { chat_id: chatId, text: `Mahsulot topilmadi. Buyurtma uchun: ${s.phone}` });
  if (info.stock <= 0) {
    return tg('sendMessage', {
      chat_id: chatId,
      text: `❌ «${info.name}» hozir sotuvda yo'q.`,
      reply_markup: { inline_keyboard: [[{ text: '🔔 Kelganda xabar ber', callback_data: `w:a:${pid}`.slice(0, 64) }]] },
    });
  }
  await setDraft(user, { ...info, step: 'qty', at: Date.now() });
  const max = Math.min(info.stock, 5);
  const nums = Array.from({ length: max }, (_, i) => ({ text: String(i + 1), callback_data: `ord:q:${i + 1}` }));
  const text = `🛒 <b>${esc(info.name)}</b>\n🔢 SKU: ${esc(info.sku)}\n💰 Narxi: ${info.price > 0 ? `${formatPrice(info.price)} so'm` : 'kelishiladi'}\n\nNechta kerak?`;
  const kb = { inline_keyboard: [nums, ...(info.stock > 5 ? [[{ text: '✏️ Boshqa son', callback_data: 'ord:q:x' }]] : []), [{ text: CANCEL, callback_data: 'ord:no' }]] };
  if (info.img) {
    return tg('sendPhoto', { chat_id: chatId, photo: info.img, caption: text, parse_mode: 'HTML', reply_markup: kb }).catch(() =>
      tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb }),
    );
  }
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: kb });
}

const askPhone = (chatId) =>
  tg('sendMessage', {
    chat_id: chatId,
    text: '📞 Telefon raqamingizni yuboring — pastdagi tugmani bosing yoki yozing (masalan +998901234567):',
    reply_markup: { keyboard: [[{ text: '📱 Raqamni yuborish', request_contact: true }], [{ text: CANCEL }]], resize_keyboard: true, one_time_keyboard: true },
  });

const askAddress = (chatId) =>
  tg('sendMessage', {
    chat_id: chatId,
    text: "📍 Yetkazib berish manzilini yozing yoki lokatsiya yuboring. O'zingiz olib ketsangiz — pastdagi tugma:",
    reply_markup: { keyboard: [[{ text: '📍 Lokatsiyani yuborish', request_location: true }], [{ text: PICKUP }], [{ text: CANCEL }]], resize_keyboard: true, one_time_keyboard: true },
  });

function summary(d) {
  const total = d.price > 0 ? d.price * d.qty : 0;
  return [
    `🛍 ${esc(d.name)}`,
    `🔢 SKU: ${esc(d.sku)}`,
    `📦 Soni: ${d.qty} dona`,
    `💰 ${d.price > 0 ? `${formatPrice(d.price)} × ${d.qty} = <b>${formatPrice(total)} so'm</b>` : 'Narxi: kelishiladi'}`,
    `📞 ${esc(d.phone)}`,
    `📍 ${d.pickup ? "O'zi olib ketadi" : d.location ? `Lokatsiya: https://maps.google.com/?q=${d.location.latitude},${d.location.longitude}` : esc(d.address)}`,
  ].join('\n');
}

const confirmView = (chatId, d) =>
  tg('sendMessage', {
    chat_id: chatId,
    text: `🧾 <b>Buyurtmangiz:</b>\n\n${summary(d)}\n\nTasdiqlaysizmi?`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 'ord:ok' }, { text: CANCEL, callback_data: 'ord:no' }]] },
  }).then(() => tg('sendMessage', { chat_id: chatId, text: '👆 Tekshiring va tasdiqlang.', reply_markup: removeKb }).catch(() => {}));

// A message from a customer who is in the middle of an order. true = handled.
export async function handleOrderMessage(msg, s) {
  const user = String(msg.from?.id);
  const d = await getDraft(user);
  if (!d) return false;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (text === CANCEL || /^\/(cancel|bekor)/.test(text)) {
    await dropDraft(user);
    await tg('sendMessage', { chat_id: chatId, text: '❌ Buyurtma bekor qilindi.', reply_markup: removeKb });
    return true;
  }
  if (text.startsWith('/start')) {
    await dropDraft(user); // a new start: the old draft is forgotten
    return false;
  }
  if (d.step === 'qty') {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1) {
      await tg('sendMessage', { chat_id: chatId, text: '✏️ Sonini raqam bilan yozing (masalan 2):' });
      return true;
    }
    if (n > d.stock) {
      await tg('sendMessage', { chat_id: chatId, text: `Hozir ${d.stock} dona bor — ${d.stock} yoki kamroq yozing:` });
      return true;
    }
    await setDraft(user, { ...d, qty: n, step: 'phone' });
    await askPhone(chatId);
    return true;
  }
  if (d.step === 'phone') {
    const phone = msg.contact?.phone_number || (PHONE_RE.test(text) ? text.replace(/[\s()-]/g, '') : null);
    if (!phone) {
      await tg('sendMessage', { chat_id: chatId, text: "📞 Raqamni to'g'ri yozing (masalan +998901234567) yoki «📱 Raqamni yuborish» tugmasini bosing." });
      return true;
    }
    await setDraft(user, { ...d, phone: phone.startsWith('+') ? phone : `+${phone}`, step: 'address' });
    await askAddress(chatId);
    return true;
  }
  if (d.step === 'address') {
    const next = { ...d, step: 'confirm' };
    if (msg.location) next.location = { latitude: msg.location.latitude, longitude: msg.location.longitude };
    else if (text === PICKUP) next.pickup = true;
    else if (text.length >= 3) next.address = text.slice(0, 300);
    else {
      await tg('sendMessage', { chat_id: chatId, text: "📍 Manzilni yozing (ko'cha, uy) yoki lokatsiya yuboring:" });
      return true;
    }
    await setDraft(user, next);
    await confirmView(chatId, next);
    return true;
  }
  if (d.step === 'confirm') {
    await tg('sendMessage', { chat_id: chatId, text: '👆 Yuqoridagi buyurtmani «✅ Tasdiqlash» yoki «❌ Bekor qilish» bilan yakunlang.' });
    return true;
  }
  return false;
}

// Optional (admin switch, test mode): a sale order in BITO. Throws with BITO's answer.
async function createBitoOrder(d, order) {
  const responsible = process.env.BITO_RESPONSIBLE_ID;
  if (!responsible) throw new Error("BITO_RESPONSIBLE_ID (mas'ul xodim ID) Vercel'da yo'q");
  const org = d.org || process.env.BITO_ORGANIZATION_ID;
  if (!org) throw new Error("mahsulotning filiali (organization) noma'lum");
  const phone = String(d.phone).replace(/\D/g, ''); // BITO keeps numbers without "+"
  let customer = null;
  try {
    customer = await bitoPost('/customer/get-by-phone-number', { phone_number: phone });
  } catch {
    /* not found -> created below */
  }
  const customerId =
    customer?._id ||
    customer?.data?._id ||
    (await bitoPost('/customer/create', { name: order.customer || phone, phone_number: phone, type: 'NATURAL', organization_ids: [org] }))?._id;
  if (!customerId) throw new Error("BITO'da mijoz yaratilmadi");
  const res = await bitoPost('/sale-order/create', {
    state: process.env.BITO_ORDER_STATE || 'new',
    organization_id: org,
    customer_id: customerId,
    responsible_id: responsible,
    date: new Date().toISOString(),
    discounts: [],
    products: [{ product_id: d.pid, quantity: d.qty, price: d.price }],
    note: `Telegram bot #${order.id}: ${d.pickup ? "o'zi olib ketadi" : d.address || (d.location ? `${d.location.latitude},${d.location.longitude}` : '')}`,
  });
  return res?._id || res?.number || 'ok';
}

const orderButtons = (id) => ({ inline_keyboard: [[{ text: '✅ Qabul qilindi', callback_data: `ord:a:${id}` }, { text: '❌ Bekor qilish', callback_data: `ord:x:${id}` }]] });

// "ord:*" buttons — customers (quantity, confirm, cancel) and staff (accept / cancel an order).
export async function handleOrderCallback(cb, s, { isStaff = false } = {}) {
  const [, action, arg] = (cb.data || '').split(':');
  const user = String(cb.from.id);
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  // staff side
  if (action === 'a' || action === 'x') {
    if (!isStaff) return answer("Ruxsat yo'q", true);
    const o = await db.redis().hget(db.K.orders, arg);
    if (!o) return answer('Buyurtma topilmadi', true);
    if (o.status !== 'new') return answer(`Bu buyurtma allaqachon: ${o.status === 'accepted' ? 'qabul qilingan' : 'bekor qilingan'}`, true);
    const status = action === 'a' ? 'accepted' : 'cancelled';
    const by = cb.from.username ? `@${cb.from.username}` : cb.from.first_name || cb.from.id;
    await db.redis().hset(db.K.orders, { [arg]: { ...o, status, by, done_at: Date.now() } });
    await answer(status === 'accepted' ? '✅ Qabul qilindi' : '❌ Bekor qilindi');
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: `${cb.message.text}\n\n${status === 'accepted' ? '✅ Qabul qilindi' : '❌ Bekor qilindi'}: ${by}`,
    }).catch(() => {});
    await tg('sendMessage', {
      chat_id: o.chat,
      text: status === 'accepted' ? `✅ Buyurtmangiz #${arg} qabul qilindi. Tez orada siz bilan bog'lanamiz.` : `❌ Buyurtmangiz #${arg} bekor qilindi. Savollar bo'lsa: ${s.phone}`,
    }).catch(() => {});
    return null;
  }
  // customer side
  const d = await getDraft(user);
  if (action === 'no') {
    await dropDraft(user);
    await answer('Bekor qilindi');
    return tg('sendMessage', { chat_id: chatId, text: '❌ Buyurtma bekor qilindi.', reply_markup: removeKb });
  }
  if (!d) return answer('Buyurtma eskirgan — kartochkadagi «🛒 Buyurtma berish» ni qayta bosing.', true);
  if (action === 'q') {
    await answer();
    if (arg === 'x') {
      await setDraft(user, { ...d, step: 'qty' });
      return tg('sendMessage', { chat_id: chatId, text: `✏️ Nechta kerak? Raqam bilan yozing (1–${d.stock}):` });
    }
    await setDraft(user, { ...d, qty: Number(arg), step: 'phone' });
    return askPhone(chatId);
  }
  if (action === 'ok') {
    if (d.step !== 'confirm') return answer('Avval barcha savollarga javob bering', true);
    await answer('✅ Yuborildi');
    const id = String(await db.redis().hincrby(db.K.orders, 'seq', 1));
    const customer = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(' ') || 'Mijoz';
    const order = { id, chat: String(chatId), user, customer, username: cb.from.username || null, ...d, status: 'new', at: Date.now() };
    await db.redis().hset(db.K.orders, { [id]: order });
    await dropDraft(user);
    await db.incrStat('orders');
    let bitoLine = '';
    if (s.order_bito) {
      try {
        bitoLine = `\n🧾 BITO: buyurtma yaratildi (${esc(await createBitoOrder(d, order))})`;
      } catch (e) {
        const why = e.details?.message ? `${e.details.message} (${e.details.path})` : errText(e);
        bitoLine = `\n⚠️ BITO'da yaratilmadi: ${esc(String(why).slice(0, 200))}`;
        console.error(`BITO order #${id}: ${why}`);
      }
    }
    const who = `👤 ${esc(customer)}${order.username ? ` (@${esc(order.username)})` : ''} — <a href="tg://user?id=${esc(user)}">yozish</a>`;
    const text = `🛒 <b>Yangi buyurtma #${id}</b>\n\n${summary(d)}\n${who}\n📦 Omborda: ${d.stock} dona${bitoLine}`;
    const payload = { text, parse_mode: 'HTML', reply_markup: orderButtons(id), disable_web_page_preview: true };
    if (s.order_group) {
      await tg('sendMessage', { chat_id: s.order_group, ...payload }).catch(async (e) => {
        console.error(`order #${id} to group: ${errText(e)}`);
        await notifyAdmins(payload);
      });
    } else {
      await notifyAdmins(payload);
    }
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return tg('sendMessage', { chat_id: chatId, text: `✅ Buyurtmangiz #${id} qabul qilindi! Menejer tez orada ${d.phone} raqamiga bog'lanadi.\n\nSavollar bo'lsa: ${s.phone}`, reply_markup: removeKb });
  }
  return answer();
}

// The bot's own @username (for t.me/<bot>?start=o_… links), kept in the settings.
export async function ensureBotUsername(s) {
  if (s.bot_username) return s.bot_username;
  const me = await tg('getMe').catch(() => null);
  if (me?.username) await db.updateSettings({ bot_username: me.username });
  return me?.username || null;
}

