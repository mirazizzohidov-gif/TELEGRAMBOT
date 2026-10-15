// "🔔 Kelganda xabar ber": a customer finds a product in the bot's private chat (name / SKU / barcode, or
// a t.me/<bot>?start=w_<product_id> link). If it is out of stock, they subscribe; when the stock scanner
// sees the product come back (0 -> >0), the bot writes to each of them personally (photo, price, order
// button) and the subscription ends.

import { findBySku, getProductById, getProductsPage, loadDiscounts, priceFor, productImage, productStock, toItem } from './bito.js';
import { buildPostCaption } from './caption.js';
import { CATALOG_BUTTON, showCatalog } from './catalog.js';
import { handleOrderMessage, orderKb, startOrder } from './orders.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

const MAX_PER_USER = 20;
const PHOTO_BUTTON = "📷 Rasm bo'yicha qidirish";
const SEARCH_SHOW = 5;
const WAIT_TTL = 60 * 60 * 24 * 90; // a subscription lives 90 days

const isTradable = (p) => p && p.is_product !== false && !p.is_archived && !p.is_deleted && !p.completely_deleted;

export const HELP_TEXT =
  "🔎 Mahsulot nomi, SKU yoki shtrix-kodini yozing — narxi va bor-yo'qligini ko'rsataman.\n" +
  "Hozir yo'q bo'lsa, \"🔔 Kelganda xabar ber\" tugmasini bosing — kelishi bilan sizga yozaman.\n\n" +
  "📋 /kutish — kutayotgan mahsulotlaringiz";

// ---- storage ----
// K.wait(pid): hash user_id -> { chat, at, sku, name }; K.waitIndex: hash pid -> number of waiters;
// K.waitUser(uid): hash pid -> { sku, name, at }.

async function subscribers(pid) {
  return (await db.redis().hgetall(db.K.wait(pid))) || {};
}

export async function waitingCount() {
  if (!db.hasRedis()) return 0;
  return Object.values((await db.redis().hgetall(db.K.waitIndex)) || {}).reduce((n, v) => n + (Number(v) || 0), 0);
}

export async function hasWaiters() {
  return (await waitingCount()) > 0;
}

async function setIndex(pid) {
  const n = Object.keys(await subscribers(pid)).length;
  if (n) await db.redis().hset(db.K.waitIndex, { [pid]: n });
  else await db.redis().hdel(db.K.waitIndex, pid);
}

export async function subscribe(user, chat, p) {
  const pid = String(p._id);
  const mine = (await db.redis().hgetall(db.K.waitUser(user))) || {};
  if (!mine[pid] && Object.keys(mine).length >= MAX_PER_USER) return { full: true };
  await db.redis().hset(db.K.wait(pid), { [user]: { chat, at: Date.now(), sku: String(p.sku), name: p.name } });
  await db.redis().expire(db.K.wait(pid), WAIT_TTL);
  await db.redis().hset(db.K.waitUser(user), { [pid]: { sku: String(p.sku), name: p.name, at: Date.now() } });
  await db.redis().expire(db.K.waitUser(user), WAIT_TTL);
  await setIndex(pid);
  return { ok: true };
}

export async function unsubscribe(user, pid) {
  await db.redis().hdel(db.K.wait(pid), String(user));
  await db.redis().hdel(db.K.waitUser(user), pid);
  await setIndex(pid);
}

// ---- customer chat ----

export async function card(chatId, p, s, discounts) {
  const stock = productStock(p);
  const pr = await priceFor(p, discounts).catch(() => ({ price: 0 }));
  const item = toItem(p, pr);
  const lines = [buildPostCaption(item, s.phone), '', `🔢 SKU: ${p.sku}`, stock > 0 ? `✅ Sotuvda bor: ${stock} dona` : "❌ Hozir yo'q"];
  const kb = stock > 0 ? orderKb(s, { product_id: String(p._id) }) : {
    inline_keyboard: [
      [{ text: '🔔 Kelganda xabar ber', callback_data: `w:a:${p._id}`.slice(0, 64) }],
      [{ text: '🛒 Buyurtma berish', url: s.order_url }],
    ],
  };
  const caption = lines.join('\n');
  if (item.image_url) {
    try {
      return await tg('sendPhoto', { chat_id: chatId, photo: item.image_url, caption, parse_mode: 'HTML', reply_markup: kb });
    } catch (e) {
      console.error(`waitlist card photo ${p.sku}: ${errText(e)}`);
    }
  }
  return tg('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: kb });
}

async function listMine(chatId, user) {
  const mine = Object.entries((await db.redis().hgetall(db.K.waitUser(user))) || {});
  if (!mine.length) return tg('sendMessage', { chat_id: chatId, text: `📋 Siz hech narsa kutmayapsiz.\n\n${HELP_TEXT}` });
  return tg('sendMessage', {
    chat_id: chatId,
    text: `📋 Kelishini kutayotganlaringiz (${mine.length}):\n\n${mine.map(([, w], i) => `${i + 1}. ${w.name} (SKU ${w.sku})`).join('\n')}\n\nBekor qilish uchun bosing:`,
    reply_markup: { inline_keyboard: mine.map(([pid, w]) => [{ text: `❌ ${String(w.name).slice(0, 40)}`, callback_data: `w:d:${pid}`.slice(0, 64) }]) },
  });
}

// Private messages from customers (not admins).
export async function handleCustomerMessage(msg, s) {
  const chatId = msg.chat.id;
  const user = String(msg.from?.id || chatId);
  const text = (msg.text || '').trim();
  const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
  try {
    // in the middle of an order: quantity / phone / address / confirmation
    if (await handleOrderMessage(msg, s)) return null;
    // "🛒 Buyurtma berish" from a post: t.me/<bot>?start=o_<product_id>
    if (start && (start[1] === 'o' || start[1]?.startsWith('o_'))) return startOrder(chatId, user, start[1].slice(2) || null, s);
    if (text === CATALOG_BUTTON || /^\/(katalog|catalog)(@\w+)?$/.test(text)) return showCatalog(chatId, s);
    if (start && start[1]?.startsWith('w_')) {
      const p = await getProductById(start[1].slice(2)).catch(() => null);
      if (!p || !isTradable(p)) return tg('sendMessage', { chat_id: chatId, text: `Mahsulot topilmadi.\n\n${HELP_TEXT}` });
      return card(chatId, p, s, await loadDiscounts());
    }
    if (/^\/(kutish|wait)(@\w+)?$/.test(text)) return listMine(chatId, user);
    // "📷 Rasm bo'yicha qidirish": a photo -> the product in BITO
    if (msg.photo?.length || msg.document?.mime_type?.startsWith('image/')) {
      const { handlePhotoSearch } = await import('./photosearch.js');
      return handlePhotoSearch(msg, s, 'customer');
    }
    if (text === PHOTO_BUTTON) {
      return tg('sendMessage', { chat_id: chatId, text: "📷 Mahsulot rasmini yuboring — narxi va bor-yo'qligini topib beraman." });
    }
    if (start || text.startsWith('/') || text.length < 2) {
      const r = await tg('sendMessage', {
        chat_id: chatId,
        text: `Assalomu alaykum! Buyurtma uchun: ${s.phone}\n\n${HELP_TEXT}`,
        reply_markup: { inline_keyboard: [[{ text: '🛒 Buyurtma berish', url: s.order_url }]] },
      });
      if (start) {
        // the customer keyboard: catalog, and the photo search when Gemini is on
        const photo = s.photo_search !== false && process.env.GEMINI_API_KEY;
        await tg('sendMessage', {
          chat_id: chatId,
          text: photo ? "🗂 Katalogdan tanlang, nomini yozing yoki 📷 mahsulot rasmini yuboring — topib beraman." : '🗂 Katalogdan tanlang yoki mahsulot nomini yozing.',
          reply_markup: { keyboard: [[{ text: CATALOG_BUTTON }, ...(photo ? [{ text: PHOTO_BUTTON }] : [])]], resize_keyboard: true, is_persistent: true },
        });
      }
      return r;
    }
    const { list } = await getProductsPage({ page: 1, limit: 20, search: text });
    let found = list.filter(isTradable);
    if (!found.length && s.photo_search !== false && process.env.GEMINI_API_KEY) {
      // not found as written: Gemini suggests spellings / synonyms -> similar products
      const { findByName } = await import('./photosearch.js');
      const r = await findByName(text, { limit: SEARCH_SHOW }).catch(() => ({ results: [] }));
      if (r.results.length) {
        await tg('sendMessage', { chat_id: chatId, text: `🔎 «${text}» aynan topilmadi — o'xshashlari:` });
        found = r.results;
      }
    }
    if (!found.length) return tg('sendMessage', { chat_id: chatId, text: `🔎 «${text}» bo'yicha hech narsa topilmadi.\n\n${HELP_TEXT}` });
    const discounts = await loadDiscounts();
    // Exact SKU / barcode first, then products with a photo.
    found.sort((a, b) => (String(b.sku) === text) - (String(a.sku) === text) || Boolean(productImage(b)) - Boolean(productImage(a)));
    for (const p of found.slice(0, SEARCH_SHOW)) await card(chatId, p, s, discounts);
    if (found.length > SEARCH_SHOW) {
      await tg('sendMessage', { chat_id: chatId, text: `Yana ${found.length - SEARCH_SHOW} ta topildi — aniqroq yozing (masalan SKU).` });
    }
  } catch (e) {
    console.error(`customer message failed: ${errText(e)}`);
    return tg('sendMessage', { chat_id: chatId, text: `Hozir qidirib bo'lmadi, keyinroq urinib ko'ring. Buyurtma uchun: ${s.phone}` }).catch(() => {});
  }
}

// "w:a:<pid>" subscribe, "w:d:<pid>" unsubscribe — any user.
export async function handleWaitCallback(cb) {
  const [, action, pid] = (cb.data || '').split(':');
  const user = String(cb.from.id);
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  try {
    if (action === 'd') {
      await unsubscribe(user, pid);
      await answer('❌ Bekor qilindi');
      return listMine(chatId, user);
    }
    const p = await getProductById(pid).catch(() => null);
    if (!p || !isTradable(p)) return answer('Mahsulot topilmadi', true);
    if (productStock(p) > 0) return answer(`✅ Bu mahsulot hozir sotuvda bor (${productStock(p)} dona) — buyurtma berishingiz mumkin.`, true);
    const r = await subscribe(user, chatId, p);
    if (r.full) return answer(`Ko'pi bilan ${MAX_PER_USER} ta mahsulot kutish mumkin — /kutish orqali keraksizini bekor qiling.`, true);
    await db.incrStat('wait_subscribed');
    return answer('🔔 Yaxshi! Mahsulot kelishi bilan sizga xabar beraman.', true);
  } catch (e) {
    console.error(`wait callback failed: ${errText(e)}`);
    return answer("Xatolik — keyinroq urinib ko'ring", true);
  }
}

// Called on every real "back in stock" (0 -> >0). Writes to everyone waiting for the product.
export async function notifyWaiters(pid, s) {
  if (!db.hasRedis()) return 0;
  const subs = await subscribers(pid);
  const users = Object.entries(subs);
  if (!users.length) return 0;
  const any = users[0][1];
  const p = (await findBySku(String(any.sku), { fresh: true }).catch(() => null)) || (await getProductById(pid).catch(() => null));
  if (!p || String(p._id) !== String(pid) || productStock(p) <= 0) return 0;
  const item = toItem(p, await priceFor(p, await loadDiscounts()).catch(() => ({ price: 0 })));
  const caption = `🔔 <b>Siz kutgan mahsulot keldi!</b>\n\n${buildPostCaption(item, s.phone)}\n\n✅ Sotuvda: ${productStock(p)} dona`;
  let sent = 0;
  for (const [user, w] of users) {
    try {
      if (item.image_url) {
        await tg('sendPhoto', { chat_id: w.chat, photo: item.image_url, caption, parse_mode: 'HTML', reply_markup: orderKb(s, item) }).catch(() =>
          tg('sendMessage', { chat_id: w.chat, text: caption, parse_mode: 'HTML', reply_markup: orderKb(s, item) }),
        );
      } else {
        await tg('sendMessage', { chat_id: w.chat, text: caption, parse_mode: 'HTML', reply_markup: orderKb(s, item) });
      }
      sent++;
    } catch (e) {
      console.error(`waiter ${user} for ${item.sku}: ${errText(e)}`); // e.g. the user blocked the bot
    }
    await unsubscribe(user, String(pid));
  }
  await db.incrStat('wait_notified', sent);
  console.log(`waitlist: ${item.sku} back — ${sent}/${users.length} waiters told`);
  return sent;
}
