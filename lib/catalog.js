// "🗂 Katalog" for customers: BITO's categories (main ones first, then their sub-categories) with only
// what is in stock, then the products as customer cards (photo, price, SKU, order button), 5 at a time.

import { findBySku, loadDiscounts } from './bito.js';
import { categoryStats } from './stock.js';
import { tg } from './telegram.js';
import { mapLimit } from './util.js';
import { card } from './waitlist.js';

export const CATALOG_BUTTON = '🗂 Katalog';
const PAGE = 8; // category buttons per page
const SHOW = 5; // products per "➡️ Yana"

const visibleKids = (n) => (n.children || []).filter((c) => !c.empty && c.i > 0);

async function tree(s) {
  const stats = await categoryStats(s);
  return { nodes: stats.nodes, roots: stats.rows.filter((r) => r.id !== 'none' && r.i > 0) };
}

function pageButtons(items, page, cb, back) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = items.slice(p * PAGE, (p + 1) * PAGE).map(([text, data]) => [{ text, callback_data: data.slice(0, 64) }]);
  const nav = [];
  if (p > 0) nav.push({ text: '⬅️', callback_data: cb(p - 1) });
  if (p < pages - 1) nav.push({ text: '➡️', callback_data: cb(p + 1) });
  if (nav.length) rows.push(nav);
  if (back) rows.push([back]);
  return { rows, p, pages };
}

const nodeButton = (c) => [`${c.name} (${c.i})`, visibleKids(c).length ? `kt:n:${c.id}:0` : `kt:p:${c.id}:0`];

// The main categories (or one category's sub-categories) — edits the message when paging.
export async function showCatalog(chatId, s, { id = null, page = 0, messageId = null } = {}) {
  const { nodes, roots } = await tree(s);
  let text;
  let items;
  let back = null;
  let cb;
  if (!id) {
    if (!roots.length) return tg('sendMessage', { chat_id: chatId, text: "🗂 Katalog hozircha bo'sh — mahsulot nomini yozing yoki rasmini yuboring." });
    text = '🗂 <b>Katalog</b> — kategoriyani tanlang (qavsda: sotuvda bor mahsulotlar):';
    items = [...roots].sort((a, b) => a.name.localeCompare(b.name)).map(nodeButton);
    cb = (p) => `kt:r:${p}`;
  } else {
    const n = nodes.get(id);
    if (!n) return tg('sendMessage', { chat_id: chatId, text: '🗂 Kategoriya topilmadi — /katalog' });
    text = `🗂 <b>${n.name}</b> — ${n.i} ta mahsulot sotuvda:`;
    items = [[`📦 Hammasi (${n.i})`, `kt:p:${n.id}:0`], ...visibleKids(n).sort((a, b) => a.name.localeCompare(b.name)).map(nodeButton)];
    const parent = n.parent && nodes.get(n.parent);
    back = { text: `⬅️ ${parent ? parent.name : 'Katalog'}`, callback_data: (parent ? `kt:n:${parent.id}:0` : 'kt:r:0').slice(0, 64) };
    cb = (p) => `kt:n:${n.id}:${p}`.slice(0, 64);
  }
  const v = pageButtons(items, page, cb, back);
  const payload = { chat_id: chatId, text: `${text}${v.pages > 1 ? ` · ${v.p + 1}/${v.pages}` : ''}`, parse_mode: 'HTML', reply_markup: { inline_keyboard: v.rows } };
  if (messageId) return tg('editMessageText', { ...payload, message_id: messageId }).catch(() => tg('sendMessage', payload));
  return tg('sendMessage', payload);
}

// Products of a category (with its sub-categories) that are in stock, as customer cards.
export async function showProducts(chatId, s, id, offset = 0) {
  const { nodes } = await tree(s);
  const n = nodes.get(id);
  if (!n) return tg('sendMessage', { chat_id: chatId, text: '🗂 Kategoriya topilmadi — /katalog' });
  const list = (n.all || []).filter((r) => r.stock > 0).sort((a, b) => Boolean(b.img) - Boolean(a.img) || String(a.name).localeCompare(String(b.name)));
  const part = list.slice(offset, offset + SHOW);
  if (!part.length) return tg('sendMessage', { chat_id: chatId, text: `🗂 ${n.name}: hozir sotuvda mahsulot yo'q.` });
  const discounts = await loadDiscounts();
  const products = await mapLimit(part, 3, (r) => findBySku(String(r.sku)).catch(() => null));
  for (const p of products.filter(Boolean)) await card(chatId, p, s, discounts);
  const shown = offset + part.length;
  const rows = [];
  if (shown < list.length) rows.push([{ text: `➡️ Yana ${Math.min(SHOW, list.length - shown)} ta (${shown}/${list.length})`, callback_data: `kt:p:${id}:${shown}`.slice(0, 64) }]);
  rows.push([{ text: `⬅️ ${n.name}`, callback_data: (visibleKids(n).length ? `kt:n:${id}:0` : n.parent ? `kt:n:${n.parent}:0` : 'kt:r:0').slice(0, 64) }]);
  return tg('sendMessage', { chat_id: chatId, text: `🗂 ${n.name}: ${shown} / ${list.length}`, reply_markup: { inline_keyboard: rows } });
}

// "kt:*" buttons (any user).
export async function handleCatalogCallback(cb, s) {
  const [, kind, id, extra] = (cb.data || '').split(':');
  const chatId = cb.message?.chat.id ?? cb.from.id;
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (kind === 'r') return showCatalog(chatId, s, { page: Number(id) || 0, messageId: cb.message?.message_id });
  if (kind === 'n') return showCatalog(chatId, s, { id, page: Number(extra) || 0, messageId: cb.message?.message_id });
  if (kind === 'p') return showProducts(chatId, s, id, Number(extra) || 0);
  return null;
}
