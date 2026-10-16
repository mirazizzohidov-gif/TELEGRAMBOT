// "📢 2-kanal": a second channel that gets the same posts as the main channels, with the price raised by
// a markup percent (only in the caption — nothing is written to BITO). Stories, groups and the main
// channels keep the BITO price.
//
// settings.channel2 = { id, title, username, enabled, markup_percent }
// Every channel post goes through poster.js postToChannels, which also sends to this channel (its own
// dedupe and retry queue: an error here never stops the main channels or the stories).

import { formatPrice } from './bito.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

export const DEFAULT_MARKUP = 30;
export const MARKUP_MIN = 0;
export const MARKUP_MAX = 500;
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const DEDUPE_TTL = 60 * 60 * 12; // the same automatic post is not sent to the 2nd channel twice within 12 h
const MAX_TRIES = 3;

// Only this admin may connect / change the 2nd channel (CHANNEL2_OWNER_ID overrides).
export const channel2Owner = () => String(process.env.CHANNEL2_OWNER_ID || '5812004211');
export const isChannel2Owner = (userId) => userId != null && String(userId) === channel2Owner();

const pct = (p) => {
  const n = Number(p);
  return Number.isInteger(n) && n >= MARKUP_MIN && n <= MARKUP_MAX ? n : 0;
};

// The 2nd channel price: original × (1 + p/100), to the nearest thousand (half up):
// floor(x / 1000 + 0.5) × 1000 — 16049 → 16 000, 15600 → 16 000, 15470 → 15 000.
// 0, negative or not a number -> 0 (no price); a positive price never becomes 0 (at least 1 000).
// Integer math (price × (100 + p) / 100) so 1250 × 1.2 is exactly 1500 and rounds up.
export function markupPrice(price, percent = 0) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const raised = (n * (100 + pct(percent))) / 100;
  const rounded = Math.floor(raised / 1000 + 0.5) * 1000;
  return rounded > 0 ? rounded : 1000;
}

// The settings' 2nd channel when it is connected and switched on, else null.
export function channel2Target(s) {
  const c = s?.channel2;
  return c && c.id && c.enabled ? { id: String(c.id), title: c.title || c.id, markup: pct(c.markup_percent), ch2: true } : null;
}

export const markupOf = (s) => pct(s?.channel2?.markup_percent ?? DEFAULT_MARKUP);

// The item as the 2nd channel shows it: price and old (struck-through) price both raised and rounded.
export function ch2Item(item, percent) {
  const out = { ...item, price: markupPrice(item.price, percent), ch2: true };
  if (Number(item.old_price) > 0) out.old_price = markupPrice(item.old_price, percent);
  return out;
}

export const ch2Label = (c) => (c.username ? `@${c.username}` : c.title || c.id);

// "📢 2-kanal (+30%): 22 000 → 29 000 so'm" — for previews.
export function ch2PriceLine(item, s) {
  const t = channel2Target(s);
  if (!t) return '';
  const m = ch2Item(item, t.markup);
  const discounted = Number(m.old_price) > Number(m.price);
  return `📢 2-kanal narxi (+${t.markup}%): ${discounted ? `<s>${formatPrice(m.old_price)}</s> → ` : ''}${formatPrice(m.price)} so'm`;
}

// ---- connecting ----

// Checks that the chat is a channel where the bot is an admin that may post.
// Returns { ok: true, chat: { id, title, username } } or { ok: false, error }.
// mainIds: the main channels (ids or @usernames) — one of them cannot be the 2nd channel.
export async function checkChannel2(text, { mainIds = [] } = {}) {
  const ref = String(text || '').trim();
  if (!/^(@[A-Za-z0-9_]{4,}|-100\d{5,})$/.test(ref)) {
    return { ok: false, error: "Kanalni @username yoki -100... ID ko'rinishida yuboring." };
  }
  let chat;
  try {
    chat = await tg('getChat', { chat_id: ref });
  } catch (e) {
    return { ok: false, error: `Kanal ${ref} topilmadi yoki bot unga qo'shilmagan (${errText(e)}). Avval botni kanalga admin qilib qo'shing.` };
  }
  const name = chat.username ? `@${chat.username}` : chat.title || ref;
  const main = new Set(mainIds.map((x) => String(x).toLowerCase()));
  if (main.has(String(chat.id)) || main.has(ref.toLowerCase()) || (chat.username && main.has(`@${chat.username}`.toLowerCase()))) {
    return { ok: false, error: `${name} 1-kanallar ro'yxatida bor — unga BITO narxi ketadi. 2-kanal uchun boshqa kanal yuboring.` };
  }
  if (chat.type && chat.type !== 'channel') {
    return { ok: false, error: `${name} — kanal emas (${chat.type}). Kanal @username yoki ID sini yuboring.` };
  }
  let member;
  try {
    const me = await tg('getMe');
    member = await tg('getChatMember', { chat_id: chat.id, user_id: me.id });
  } catch (e) {
    return { ok: false, error: `Bot ${name} da admin emas (${errText(e)}).` };
  }
  if (member?.status === 'creator') return { ok: true, chat: { id: String(chat.id), title: chat.title || name, username: chat.username || '' } };
  if (member?.status !== 'administrator') {
    return { ok: false, error: `Bot ${name} da admin emas. Kanal sozlamalari → Administratorlar → botni qo'shing ("Xabar joylash" huquqi bilan).` };
  }
  if (member.can_post_messages === false) {
    return { ok: false, error: `Bot ${name} da post yozish huquqi yo'q. Administratorlar → bot → "Xabar joylash" ni yoqing.` };
  }
  return { ok: true, chat: { id: String(chat.id), title: chat.title || name, username: chat.username || '' } };
}

// ---- dedupe and the retry queue ----

const dedupeKey = (t, item) => `ch2:${t.id}:${item.type || 'post'}:${item.sku}:${markupPrice(item.price, t.markup)}`;

export async function ch2AlreadySent(t, item) {
  if (!db.hasRedis()) return false;
  return Boolean(await db.redis().get(db.K.flag(dedupeKey(t, item))).catch(() => null));
}

export async function ch2MarkSent(t, item) {
  if (!db.hasRedis()) return;
  await db.redis().set(db.K.flag(dedupeKey(t, item)), 1, { ex: DEDUPE_TTL }).catch(() => {});
}

// Items whose 2nd-channel post failed (the main channel already has them): tried again next tick.
export async function enqueueCh2(items) {
  if (!items.length || !db.hasRedis()) return;
  await db.redis().rpush(db.K.ch2Queue, ...items.map((i) => ({ ...i, ch2_tries: (i.ch2_tries || 0) + 1 })));
  await db.redis().ltrim(db.K.ch2Queue, -200, -1);
}

export async function popCh2Queue(n) {
  if (!db.hasRedis()) return [];
  const all = (await db.redis().lrange(db.K.ch2Queue, 0, -1)) || [];
  if (!all.length) return [];
  await db.redis().del(db.K.ch2Queue);
  const take = all.slice(0, n);
  if (all.length > n) await db.redis().rpush(db.K.ch2Queue, ...all.slice(n));
  return take;
}

export const ch2QueueLength = async () => (db.hasRedis() ? (await db.redis().llen(db.K.ch2Queue).catch(() => 0)) || 0 : 0);
export const CH2_MAX_TRIES = MAX_TRIES;

// One line for admin reports: "📢 2-kanal (@x, +30%): ✅ 3/3" or "❌ sabab".
export function ch2ReportLine(r, total) {
  if (!r?.target) return '';
  const head = `📢 2-kanal (${esc(r.target.title)}, +${r.target.markup}%)`;
  if (!r.errors.length) return `${head}: ✅${total > 1 ? ` ${r.posted}/${total}` : ''}${r.skipped ? ` (${r.skipped} tasi avval yuborilgan)` : ''}`;
  return `${head}: ${r.posted ? `⚠️ ${r.posted}/${total}` : '❌'} ${esc(r.errors[0])}${r.queued ? ` — ${r.queued} tasi keyinroq qayta yuboriladi` : ''}`;
}
