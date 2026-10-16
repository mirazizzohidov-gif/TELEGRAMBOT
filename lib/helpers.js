// "👥 Yordamchi adminlar" (posters): people the owner admin lets create posts — and nothing else.
// Each helper has exactly ONE destination (a channel / group where the bot is an admin). In the bot a
// helper sees "📝 Post yaratish": photo -> name -> SKU -> price -> preview -> "✅ Joylash", and the post
// goes to that destination at once; the owner gets a copy ("👤 <ism> joyladi → <manzil>: <nom>, SKU").
//
// The owner manages them in the admin panel (lib/admin.js, "ha:*" buttons); the helper's own steps are
// here ("hp:*" buttons and the messages of a helper in the middle of a post).

import { findBySku, formatPrice, getAllCategories } from './bito.js';
import { contactPhone } from './caption.js';
import { ch2Settings, channel2Owner, markupOf, markupPrice } from './channel2.js';
import { categoryIdOf, tagsFor, withTags } from './hashtags.js';
import { orderKb } from './orders.js';
import { recordPost } from './postreg.js';
import * as db from './store.js';
import { downloadImage } from './story.js';
import { tg } from './telegram.js';
import { errText } from './util.js';
import { sendPhotoMarked } from './watermark.js';

export const POST_BUTTON = '📝 Post yaratish';
export const NAME_MAX = 200;
const SKU_MAX = 40;
const DRAFT_TTL = 60 * 60 * 24;
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HELPER_KEYBOARD = { keyboard: [[{ text: POST_BUTTON }]], resize_keyboard: true, is_persistent: true };
const cancelKb = { inline_keyboard: [[{ text: '❌ Bekor', callback_data: 'hp:x' }]] };

// ---- storage: hash user_id -> { id, name, dest: { id, label, kind } | null, active, added_at, posts } ----

export async function listHelpers() {
  if (!db.hasRedis()) return [];
  const all = (await db.redis().hgetall(db.K.helpers)) || {};
  return Object.values(all).sort((a, b) => (a.added_at || 0) - (b.added_at || 0));
}

export const getHelper = async (id) => (db.hasRedis() && id != null ? db.redis().hget(db.K.helpers, String(id)) : null);

export async function saveHelper(h) {
  const prev = (await getHelper(h.id)) || {};
  const next = { active: true, dest: null, posts: 0, added_at: Date.now(), ...prev, ...h, id: String(h.id) };
  await db.redis().hset(db.K.helpers, { [next.id]: next });
  return next;
}

export async function removeHelper(id) {
  await db.redis().hdel(db.K.helpers, String(id));
  await db.redis().del(draftKey(id));
}

export const helperName = (h) => h?.name || `ID ${h?.id}`;

// Which text fields this helper fills in (the owner switches each on / off; all on by default). A field
// that is off is not asked and its line is left out of the post. The photo is always required.
export const FIELDS = ['name', 'sku', 'price'];
export const helperFields = (h) => FIELDS.filter((f) => h?.fields?.[f] !== false);
const stepsOf = (h) => ['photo', ...helperFields(h)];

// An active helper (not an admin — admins have the whole panel).
export async function activeHelper(userId) {
  const h = await getHelper(userId);
  return h?.active ? h : null;
}

// ---- parsing ----

// "185000", "185 000", "185 000 so'm", "185.000" -> 185000; null when not a positive whole number.
export function parsePrice(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/so['ʻ‘’`]?m|sum|сум|uzs/g, '')
    .replace(/[\s .,']/g, '');
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

export function parseName(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { error: "Mahsulot nomini yozing." };
  if (t.length > NAME_MAX) return { error: `Nom juda uzun (${t.length} belgi) — ko'pi bilan ${NAME_MAX} belgi.` };
  return { value: t };
}

export function parseSku(text) {
  const t = String(text || '').trim();
  if (!t || t.length > SKU_MAX || !/^[\p{L}\p{N}][\p{L}\p{N}._\/-]*$/u.test(t)) {
    return { error: `SKU ni yozing (harf, raqam, "-", ko'pi bilan ${SKU_MAX} belgi, bo'shliqsiz).` };
  }
  return { value: t };
}

// "123456789" or "123456789 Ali Valiyev" -> { id, name }; a forwarded message -> its sender.
export function parseHelperRef(msg) {
  const o = msg.forward_origin;
  const fwd = o?.type === 'user' ? o.sender_user : msg.forward_from;
  if (fwd?.id) return { id: String(fwd.id), name: [fwd.first_name, fwd.last_name].filter(Boolean).join(' ') || fwd.username || '' };
  if (o?.type === 'hidden_user' || msg.forward_sender_name) {
    return { error: "Bu odam forward'da profilini yashirgan — uning Telegram ID raqamini yuboring (masalan @userinfobot dan)." };
  }
  const m = String(msg.text || '').trim().match(/^(\d{5,15})(?:\s+(.{1,60}))?$/);
  if (!m) return { error: "Telegram ID (raqam) yuboring, masalan: 123456789 Ali — yoki shu odamdan forward qilingan xabar." };
  return { id: m[1], name: (m[2] || '').trim() };
}

// ---- the post ----

// The destination's look: the 2nd channel -> its phone / button and the marked-up price; anywhere else
// the main channel's phone / button and the price as typed.
// fields: the helper's switched-on fields (a line that is off is left out, with no empty line).
export function helperPost(d, dest, s, fields = FIELDS) {
  const isCh2 = dest.kind === 'ch2' || (s.channel2?.id && String(s.channel2.id) === String(dest.id));
  const st = isCh2 ? ch2Settings(s) : s;
  const price = isCh2 ? markupPrice(d.price, markupOf(s)) : d.price;
  const body = [
    fields.includes('name') ? `🛍 Mahsulot nomi: ${esc(d.name)}` : null,
    fields.includes('sku') ? `🔖 SKU: ${esc(d.sku)}` : null,
    fields.includes('price') ? `💰 Narxi: ${formatPrice(price)} so'm` : null,
  ].filter(Boolean);
  const caption =
    '🆕 YANGI MAHSULOT\n\n' + (body.length ? `${body.join('\n')}\n\n` : '') + `📞 Buyurtma uchun murojaat qiling: ${esc(contactPhone(st.phone))}`;
  return { photo: d.photo, caption, parse_mode: 'HTML', reply_markup: orderKb(st, null) };
}

// ---- the helper's steps ----

const draftKey = (uid) => `${db.K.flag('helper')}:draft:${uid}`;
const getDraft = (uid) => db.redis().get(draftKey(uid));
const setDraft = (uid, d) => db.redis().set(draftKey(uid), d, { ex: DRAFT_TTL });
const dropDraft = (uid) => db.redis().del(draftKey(uid));

const NO_DEST = "📍 Asosiy admin hali manzil tanlamagan — post joylab bo'lmaydi. Asosiy adminga yozing.";

const ASK = {
  photo: '📷 Mahsulot rasmini yuboring (bitta rasm yoki rasm-fayl):',
  name: `🛍 Mahsulot nomini yozing (${NAME_MAX} belgigacha):`,
  sku: '🔖 SKU ni yozing:',
  price: "💰 Narxini yozing (masalan 185000 yoki 185 000):",
};
const ONE_PHOTO = '⚠️ Faqat 1 ta rasm qabul qilinadi — birinchisi olindi.';

// "2/4 🛍 Mahsulot nomini yozing" — numbered by this helper's steps
const ask = (chatId, step, h) => {
  const steps = stepsOf(h);
  return tg('sendMessage', { chat_id: chatId, text: `${steps.indexOf(step) + 1}/${steps.length} ${ASK[step]}`, reply_markup: cancelKb });
};
const complete = (d, h) => Boolean(d.photo) && helperFields(h).every((f) => d[f]);
const nextMissing = (d, h) => stepsOf(h).find((f) => !d[f]);

// The BITO product with this SKU (when the SKU field is on): its id links the post for "❌ SOTILDI",
// its category gives the hashtags. Never throws.
async function linkProduct(d, h, s) {
  if (!helperFields(h).includes('sku') || !d.sku) return { pid: null, tags: '' };
  try {
    const p = await findBySku(String(d.sku));
    if (!p) return { pid: null, tags: '' };
    const tags = s.hashtags === false ? '' : tagsFor(categoryIdOf(p), (await getAllCategories()).list);
    return { pid: String(p._id), tags };
  } catch (e) {
    console.error(`helper post: SKU ${d.sku} not linked: ${errText(e)}`);
    return { pid: null, tags: '' };
  }
}

async function showPreview(chatId, d, h, s) {
  const link = await linkProduct(d, h, s);
  const p0 = helperPost(d, h.dest, s, helperFields(h));
  const p = { ...p0, caption: withTags(p0.caption, link.tags) };
  return tg('sendPhoto', {
    chat_id: chatId,
    photo: p.photo,
    caption: `${p.caption}\n\n👆 Ko'rinishi (tugma: 🛒 Buyurtma berish)\n📍 Joylanadi: ${esc(h.dest.label)}`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Joylash', callback_data: 'hp:go' }],
        [{ text: '✏️ Tahrirlash', callback_data: 'hp:e' }, { text: '❌ Bekor', callback_data: 'hp:x' }],
      ],
    },
  });
}

// A photo / image file from the helper -> a photo file_id the bot can post again. An image sent as a
// file is downloaded and sent back as a photo once (a document file_id cannot be posted as a photo).
async function photoId(msg, chatId) {
  if (msg.photo?.length) return msg.photo[msg.photo.length - 1].file_id;
  if (!msg.document?.mime_type?.startsWith('image/')) return null;
  const f = await tg('getFile', { file_id: msg.document.file_id });
  const bytes = await downloadImage(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${f.file_path}`);
  const sharp = (await import('sharp')).default;
  const jpeg = await sharp(bytes).rotate().resize(2560, 2560, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'photo.jpg');
  form.append('caption', '✅ Rasm qabul qilindi');
  const m = await tg('sendPhoto', form);
  return m?.photo?.length ? m.photo[m.photo.length - 1].file_id : null;
}

// A message from an active helper. Returns true when handled (else it is treated as a customer's).
export async function handleHelperMessage(msg, h, s) {
  const chatId = msg.chat.id;
  const uid = String(msg.from.id);
  const text = (msg.text || '').trim();
  if (/^\/start(@\w+)?$/.test(text)) {
    await dropDraft(uid);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Assalomu alaykum, ${esc(helperName(h))}! Siz yordamchi adminsiz: "${POST_BUTTON}" tugmasi bilan post joylaysiz.${h.dest ? `\n📍 Manzil: ${esc(h.dest.label)}` : `\n${NO_DEST}`}`,
      parse_mode: 'HTML',
      reply_markup: HELPER_KEYBOARD,
    });
    return true;
  }
  if (text === POST_BUTTON || /^\/post(@\w+)?$/.test(text)) {
    if (!h.dest) {
      await tg('sendMessage', { chat_id: chatId, text: NO_DEST, reply_markup: HELPER_KEYBOARD });
      return true;
    }
    await setDraft(uid, { step: 'photo', at: Date.now() });
    await ask(chatId, 'photo', h);
    return true;
  }
  const d = await getDraft(uid);
  // an album comes as several messages (one per photo, maybe at the same time): only the first photo
  // is taken; the others of the same album are dropped without a word
  if (d && msg.media_group_id && !(await db.once(`hpmg:${msg.media_group_id}`, 60 * 60))) return true;
  if (!d || d.step === 'preview') {
    if (d?.step === 'preview' && (text || msg.photo)) {
      await tg('sendMessage', { chat_id: chatId, text: '👆 Yuqoridagi postni «✅ Joylash», «✏️ Tahrirlash» yoki «❌ Bekor» bilan yakunlang.' });
      return true;
    }
    return false;
  }
  if (text === '❌ Bekor' || /^\/(cancel|bekor)/.test(text)) {
    await dropDraft(uid);
    await tg('sendMessage', { chat_id: chatId, text: '❌ Bekor qilindi.', reply_markup: HELPER_KEYBOARD });
    return true;
  }
  const next = { ...d };
  if (d.step === 'photo') {
    let id = null;
    try {
      id = await photoId(msg, chatId);
    } catch (e) {
      console.error(`helper photo: ${errText(e)}`);
    }
    if (!id) {
      await tg('sendMessage', { chat_id: chatId, text: '📷 Rasm yuboring (rasm yoki rasm-fayl: jpg, png).', reply_markup: cancelKb });
      return true;
    }
    next.photo = id;
    if (msg.media_group_id) await tg('sendMessage', { chat_id: chatId, text: ONE_PHOTO });
  } else if (msg.photo?.length || msg.document?.mime_type?.startsWith('image/')) {
    // a second photo while a text is expected
    await tg('sendMessage', { chat_id: chatId, text: '⚠️ Faqat 1 ta rasm qabul qilinadi — rasm allaqachon bor.' });
    await ask(chatId, d.step, h);
    return true;
  } else if (d.step === 'name' || d.step === 'sku') {
    const r = d.step === 'name' ? parseName(text) : parseSku(text);
    if (r.error) {
      await tg('sendMessage', { chat_id: chatId, text: `❌ ${r.error}`, reply_markup: cancelKb });
      return true;
    }
    next[d.step] = r.value;
  } else if (d.step === 'price') {
    const price = parsePrice(text);
    if (!price) {
      await tg('sendMessage', { chat_id: chatId, text: "❌ Narxni raqam bilan yozing, masalan 185000 yoki 185 000.", reply_markup: cancelKb });
      return true;
    }
    next.price = price;
  }
  // editing one field goes straight back to the preview; otherwise the next step of this helper
  // (the owner may switch fields meanwhile: anything switched on and still empty is asked)
  const fresh = await getHelper(uid);
  const step = nextMissing(next, fresh || h) || null;
  if (step) {
    await setDraft(uid, { ...next, step, edit: false });
    await ask(chatId, step, fresh || h);
    return true;
  }
  if (!fresh?.dest) {
    await setDraft(uid, { ...next, step: 'preview', edit: false });
    await tg('sendMessage', { chat_id: chatId, text: NO_DEST });
    return true;
  }
  await setDraft(uid, { ...next, step: 'preview', edit: false, id: d.id || `${uid}:${Date.now()}` });
  await showPreview(chatId, next, fresh, s);
  return true;
}

// "hp:*" buttons of a helper: go (post), e (edit: choose a field), e:<field>, x (cancel), p (preview).
export async function handleHelperCallback(cb, s) {
  const uid = String(cb.from.id);
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const [, action, arg] = (cb.data || '').split(':');
  const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  const h = await activeHelper(uid);
  if (!h) return answer("Sizda post joylash huquqi yo'q.", true);
  const d = await getDraft(uid);
  const clearButtons = () =>
    tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  if (action === 'x') {
    await dropDraft(uid);
    await answer('Bekor qilindi');
    await clearButtons();
    return tg('sendMessage', { chat_id: chatId, text: '❌ Bekor qilindi.', reply_markup: HELPER_KEYBOARD });
  }
  if (!d) return answer("Post eskirgan — «📝 Post yaratish» ni qayta bosing.", true);
  if (action === 'e') {
    await answer();
    if (arg && stepsOf(h).includes(arg)) {
      await setDraft(uid, { ...d, step: arg, edit: true, [arg]: undefined });
      return ask(chatId, arg, h);
    }
    const label = { photo: '📷 Rasm', name: '🛍 Nom', sku: '🔖 SKU', price: '💰 Narx' };
    const btns = stepsOf(h).map((f) => ({ text: label[f], callback_data: `hp:e:${f}` }));
    const rows = [];
    for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
    return tg('sendMessage', {
      chat_id: chatId,
      text: "✏️ Nimani o'zgartirasiz?",
      reply_markup: { inline_keyboard: [...rows, [{ text: '⬅️ Ko\'rinishga qaytish', callback_data: 'hp:p' }]] },
    });
  }
  if (action === 'p') {
    await answer();
    if (!h.dest) return tg('sendMessage', { chat_id: chatId, text: NO_DEST });
    if (!complete(d, h)) {
      const step = nextMissing(d, h);
      await setDraft(uid, { ...d, step, edit: false });
      return ask(chatId, step, h);
    }
    return showPreview(chatId, d, h, s);
  }
  if (action === 'go') {
    if (d.step !== 'preview' || !complete(d, h)) return answer('Avval barcha bosqichlarni to\'ldiring', true);
    if (!h.dest) return answer(NO_DEST, true);
    // one press = one post (a double tap or a repeated webhook does not post twice)
    if (!(await db.once(`helperpost:${d.id}`, DRAFT_TTL))) return answer('Allaqachon joylangan', true);
    await answer('⏳ Joylanmoqda...');
    await clearButtons();
    const link = await linkProduct(d, h, s);
    const p0 = helperPost(d, h.dest, s, helperFields(h));
    const post = { ...p0, caption: withTags(p0.caption, link.tags) };
    const what = [helperFields(h).includes('name') ? d.name : 'post', helperFields(h).includes('sku') ? `SKU ${d.sku}` : null].filter(Boolean).join(', ');
    let sent;
    try {
      sent = await sendPhotoMarked({ chat_id: h.dest.id, ...post }, s);
    } catch (e) {
      await db.clearFlag(`helperpost:${d.id}`);
      const why = e.data?.description || errText(e);
      await tg('sendMessage', { chat_id: chatId, text: `❌ Joylanmadi: ${why}\n\nQayta urinib ko'ring yoki asosiy adminga yozing.`, reply_markup: { inline_keyboard: [[{ text: '🔁 Qayta urinish', callback_data: 'hp:go' }, { text: '❌ Bekor', callback_data: 'hp:x' }]] } });
      await tg('sendMessage', { chat_id: channel2Owner(), text: `❗ 👤 ${helperName(h)} joylay olmadi → ${h.dest.label}: ${what}\nSabab: ${why}` }).catch(() => {});
      return null;
    }
    await dropDraft(uid);
    if (link.pid && sent?.message_id) {
      await recordPost(link.pid, { chat: h.dest.id, mid: sent.message_id, kind: 'helper', item: { name: d.name, sku: d.sku, price: d.price }, dest: h.dest, fields: helperFields(h), tags: link.tags }, s);
    }
    await saveHelper({ id: uid, posts: (h.posts || 0) + 1, last_post_at: Date.now() });
    await db.incrStat('helper_posts').catch(() => {});
    await tg('sendMessage', { chat_id: chatId, text: `✅ Joylandi → ${h.dest.label}`, reply_markup: HELPER_KEYBOARD });
    // a copy for the owner
    await tg('sendPhoto', {
      chat_id: channel2Owner(),
      photo: post.photo,
      caption: `👤 ${esc(helperName(h))} joyladi → ${esc(h.dest.label)}: ${esc(what)}\n\n${post.caption}`.slice(0, 1024),
      parse_mode: 'HTML',
    }).catch(() =>
      tg('sendMessage', { chat_id: channel2Owner(), text: `👤 ${helperName(h)} joyladi → ${h.dest.label}: ${what}` }).catch(() => {}),
    );
    return null;
  }
  return answer();
}
