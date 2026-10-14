import { findBySku, findPrice, productImage, productStock, toItem } from './bito.js';
import { buildPostCaption } from './caption.js';
import { pickRandomProducts } from './daily.js';
import { postItemsNow, postItemsTest, postStoriesNow, randomAlbum, storySummary } from './poster.js';
import { buildReport, notifyAdmins } from './report.js';
import * as db from './store.js';
import { postProductStory } from './story.js';
import { tg } from './telegram.js';
import { runTick } from './tick.js';
import { chunk, clock, errText, isAdmin } from './util.js';

const on = (v) => (v ? '✅' : '❌');
const btn = (text, data) => ({ text, callback_data: data });
const back = [btn('⬅️ Orqaga', 'm')];
const SKU_LIST_RE = /^\d[\d-]*(?:[\s,]+\d[\d-]*)*$/;
const MAX_SKUS = 30;
const RANDOM_MAX = 30;
const PHONE_RE = /^\+?\d{9,15}$/;
const INTERACTIVE_BUDGET_MS = 50000;

const bizLabel = (b) => (b ? db.bizLabel(b) + (b.is_enabled === false ? " (o'chiq)" : '') : '');

// Number of business profiles stories go to (for button labels).
const storyProfileCount = async (s) => db.storyProfiles(s, await db.listBiz()).length;

async function menuView() {
  const [s, biz, queue, storyQueue, st] = await Promise.all([
    db.getSettings(),
    db.listBiz(),
    db.queueLength(),
    db.storyQueueLength(),
    db.getStats(),
  ]);
  const active = s.channels.filter((c) => c.active).length;
  const profiles = db.storyProfiles(s, biz);
  const perProfile = (base, limit) =>
    profiles.length ? profiles.map((p) => `${p.label} ${st[`${base}:${p.id}`] || 0}/${limit}`).join(', ') : "profil yo'q";
  return {
    text:
      `⚙️ <b>Admin panel</b>\n\n` +
      `📦 Navbatda: kanal ${queue}, story ${storyQueue}\n` +
      `✅ Bugun kanalga joylangan: ${st.posted || 0}\n` +
      `📱 Bugun story: ${perProfile('stories', db.storyDailyLimit(s))}\n` +
      `🔥 Bugun chegirma story: ${perProfile('discount_stories', db.discountStoryLimit(s))}`,
    reply_markup: {
      inline_keyboard: [
        [btn(`🎲 Random albom: ${on(s.random_album)}`, 'tr'), btn(`🎲 Random → story: ${on(s.random_story)}`, 'trs')],
        [btn(`🎲 Random ko'rinishi: ${randomAlbum(s) ? 'Albom' : 'Alohida'}`, 'trv')],
        [btn(`🆕 Yangi mahsulot → kanal: ${on(s.new_channel)}`, 'tnc')],
        [btn(`🆕 Yangi mahsulot → story: ${on(s.new_story)}`, 'tns')],
        [btn(`🔥 Chegirma → kanal: ${on(s.discount_channel)}`, 'tdc')],
        [btn(`🔥 Chegirma → story: ${on(s.discount_story)}`, 'tds')],
        [btn(`Albom rejimi: ${on(s.album)}`, 'ta')],
        [btn('⚙️ Limitlar', 'lm'), btn(`📱 Story profillari (${profiles.length}/${biz.length || profiles.length})`, 'bz')],
        [btn("🚫 Random qora ro'yxat", 'bl')],
        [btn(`📞 Telefon: ${s.phone}`, 'ph')],
        [btn(`📢 Kanallar (${active}/${s.channels.length} faol)`, 'ch')],
        [btn('🛒 Buyurtma havolasi', 'ou')],
        [btn('🚀 Hozir joylash', 'now'), btn('🎲 Random joylash', 'rj')],
        [btn('📊 Bugungi hisobot', 'rep')],
      ],
    },
  };
}

async function channelsView() {
  const s = await db.getSettings();
  const rows = s.channels.map((c, i) => [btn(`${on(c.active)} ${c.title || c.id}`, `cht:${i}`), btn('🗑', `chd:${i}`)]);
  return {
    text: s.channels.length
      ? '📢 <b>Kanallar</b>\n\nNomini bosing — faol/nofaol qiladi. 🗑 — o\'chiradi.'
      : "📢 <b>Kanallar</b>\n\nHali kanal yo'q.",
    reply_markup: { inline_keyboard: [...rows, [btn("➕ Kanal qo'shish", 'cha')], back] },
  };
}

async function bizView() {
  const [s, biz] = await Promise.all([db.getSettings(), db.listBiz()]);
  const selected = new Set(db.storyProfiles(s, biz).map((p) => p.id));
  const rows = biz.map((b) => [
    btn(`${b.is_enabled === false ? '⚪️' : on(selected.has(b.id))} ${bizLabel(b)}`, `bz:${b.id}`.slice(0, 64)),
  ]);
  return {
    text: biz.length
      ? `📱 <b>Story profillari</b> (${selected.size} ta belgilangan)\n\nStory'lar barcha ✅ profillarga yuboriladi. Bosib belgilang yoki olib tashlang. Har bir profil uchun kunlik limit alohida.`
      : "📱 Biznes ulanish yo'q.\n\nTelegram → Settings → Telegram Business → Chatbots bo'limida botni ulang.",
    reply_markup: { inline_keyboard: [...rows, back] },
  };
}

const LIMIT_LABELS = {
  story_limit: '📱 Story kunlik limiti',
  discount_story_limit: '🔥 Chegirma story kunlik limiti',
  random_album_size: '🎲 Random albomdagi mahsulotlar',
  tick_max_posts: "📤 Bir tick'da max post",
  random_repeat_days: '🔁 Random takrorlanmaslik (kun)',
};

async function limitsView() {
  const s = await db.getSettings();
  const rows = Object.keys(db.LIMITS).map((f) => [btn(`${LIMIT_LABELS[f]}: ${db.limit(s, f)}`, `lm:${f}`)]);
  return { text: '⚙️ <b>Limitlar</b>\n\nO\'zgartirish uchun tugmani bosing.', reply_markup: { inline_keyboard: [...rows, back] } };
}

// Persistent reply keyboard for admins (stays under the input field).
export const ADMIN_BUTTONS = {
  panel: '⚙️ Admin panel',
  random: '🎲 Random joylash',
  report: '📊 Hisobot',
  now: '🚀 Hozir joylash',
};

export const ADMIN_KEYBOARD = {
  keyboard: [
    [{ text: ADMIN_BUTTONS.panel }, { text: ADMIN_BUTTONS.random }],
    [{ text: ADMIN_BUTTONS.report }, { text: ADMIN_BUTTONS.now }],
  ],
  is_persistent: true,
  resize_keyboard: true,
};

// Bot commands shown to admins (set by /api/setup-webhook).
export const ADMIN_COMMANDS = [
  { command: 'admin', description: 'Admin panel' },
  { command: 'random', description: 'Random joylash' },
  { command: 'report', description: 'Hisobot' },
  { command: 'now', description: 'Hozir joylash' },
];

// Maps a reply-keyboard button or a command (/now, /now@bot) to an action.
function adminShortcut(text) {
  const cmd = text.match(/^\/(\w+)(?:@\w+)?$/)?.[1];
  if (text === ADMIN_BUTTONS.panel || cmd === 'admin' || cmd === 'start' || cmd === 'cancel') return 'panel';
  if (text === ADMIN_BUTTONS.random || cmd === 'random') return 'random';
  if (text === ADMIN_BUTTONS.report || cmd === 'report') return 'report';
  if (text === ADMIN_BUTTONS.now || cmd === 'now') return 'now';
  return null;
}

const promptView = (text) => ({ text, reply_markup: { inline_keyboard: [[btn('❌ Bekor qilish', 'm')]] } });

async function show(chatId, messageId, view) {
  const payload = { chat_id: chatId, parse_mode: 'HTML', ...view };
  if (messageId) {
    try {
      return await tg('editMessageText', { ...payload, message_id: messageId });
    } catch (e) {
      if (/not modified/i.test(e.message)) {
        return null;
      }
    }
  }
  return tg('sendMessage', payload);
}

// Plain replies to admins carry the reply keyboard so it never disappears.
const say = (chatId, text, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: ADMIN_KEYBOARD, ...extra });

// ---- manual posting: SKU list or random selection ----

const newSelectionId = () => Math.random().toString(36).slice(2, 10);

// Looks up SKUs in BITO. Imageless/priceless products are left out with a warning; the duplicate check
// is skipped on purpose (the admin asked for these products).
async function loadSkuItems(skus) {
  const items = [];
  const notes = [];
  for (const sku of skus) {
    const p = await findBySku(sku);
    if (!p) {
      notes.push(`❌ ${sku}: BITO'da topilmadi`);
      continue;
    }
    if (!productImage(p)) {
      notes.push(`⚠️ ${sku}: rasm yo'q — joylanmaydi`);
      continue;
    }
    const amount = await findPrice(p._id);
    if (!(amount > 0)) {
      notes.push(`⚠️ ${sku}: narx yo'q — joylanmaydi`);
      continue;
    }
    if (productStock(p) <= 0) {
      notes.push(`⚠️ ${sku}: qoldiq 0`);
    }
    const sent = await db.getSent(sku);
    if (sent) {
      notes.push(`ℹ️ ${sku}: avval yuborilgan (${sent.date})`);
    }
    items.push(toItem(p, amount));
  }
  return { items, notes };
}

function selectionKeyboard(id, kind, profiles = 1) {
  const story = `📱 Story (${profiles} profil)`;
  const rows =
    kind === 'random'
      ? [
          [btn('📢 Kanalga', `sel:c:${id}`), btn(story, `sel:s:${id}`)],
          [btn('📢+📱 Ikkalasi', `sel:b:${id}`), btn('🧪 Test (faqat menga)', `sel:t:${id}`)],
          [btn('🔄 Boshqa tanlash', `sel:r:${id}`), btn('❌ Bekor', `sel:x:${id}`)],
        ]
      : [
          [btn('📢 Kanalga joylash', `sel:c:${id}`), btn(story, `sel:s:${id}`)],
          [btn('📢+📱 Ikkalasi', `sel:b:${id}`), btn('🧪 Test (faqat menga)', `sel:t:${id}`)],
          [btn('❌ Bekor', `sel:x:${id}`)],
        ];
  return { inline_keyboard: rows };
}

// ---- random selection: one preview post per product, each with its own buttons ----
// Stored as { kind: 'random', n, chat_id, control_id, slots: [{ item, msg_id, removed }] }.

const itemKeyboard = (id, idx) => ({
  inline_keyboard: [
    [btn('❌ Olib tashlash', `ri:d:${id}:${idx}`), btn('🔄 Almashtirish', `ri:r:${id}:${idx}`)],
    [btn('🚫 Hech qachon', `ri:b:${id}:${idx}`)],
  ],
});

// Products still in the selection.
const selectionItems = (sel) => (sel.kind === 'random' ? sel.slots.filter((x) => !x.removed).map((x) => x.item) : sel.items);

function randomControlText(sel, s) {
  const count = selectionItems(sel).length;
  return (
    `🎲 <b>Random tanlov</b>\n` +
    `Tanlangan: ${count} ta\n` +
    `Kanalga: ${randomAlbum(s) ? 'albom' : 'alohida postlar'}\n\n` +
    (count ? 'Har bir post ostidagi tugmalar bilan tanlovni o\'zgartiring.' : "Tanlov bo'sh — \"🔄 Boshqa tanlash\" ni bosing.")
  );
}

async function updateRandomControl(id, sel, s) {
  await tg('editMessageText', {
    chat_id: sel.chat_id,
    message_id: sel.control_id,
    text: randomControlText(sel, s),
    parse_mode: 'HTML',
    reply_markup: selectionKeyboard(id, 'random', await storyProfileCount(s)),
  }).catch(() => {});
}

// Clears the per-product buttons (or deletes the preview posts) of a random selection.
async function closeRandomPreviews(sel, { remove = false } = {}) {
  for (const slot of sel.slots.filter((x) => !x.removed && x.msg_id)) {
    const target = { chat_id: sel.chat_id, message_id: slot.msg_id };
    await (remove
      ? tg('deleteMessage', target)
      : tg('editMessageReplyMarkup', { ...target, reply_markup: { inline_keyboard: [] } })
    ).catch(() => {});
  }
}

async function showRandomSelection(chatId, items, n) {
  const s = await db.getSettings();
  const id = newSelectionId();
  const slots = [];
  for (const [idx, item] of items.entries()) {
    const m = await tg('sendPhoto', {
      chat_id: chatId,
      photo: item.image_url,
      caption: buildPostCaption(item, s.phone),
      parse_mode: 'HTML',
      reply_markup: itemKeyboard(id, idx),
    });
    slots.push({ item, msg_id: m?.message_id });
  }
  const sel = { kind: 'random', n, chat_id: chatId, slots };
  const control = await say(chatId, randomControlText(sel, s), {
    reply_markup: selectionKeyboard(id, 'random', await storyProfileCount(s)),
  });
  sel.control_id = control?.message_id;
  await db.saveSelection(id, sel);
  return control;
}

// Serializes button presses on one selection so quick clicks do not overwrite each other.
async function withSelectionLock(id, fn) {
  for (let i = 0; i < 25; i++) {
    if (await db.lock(`sel:${id}`, 30)) {
      try {
        return await fn();
      } finally {
        await db.unlock(`sel:${id}`);
      }
    }
    await clock.sleep(200);
  }
  return fn();
}

// ❌ Olib tashlash / 🔄 Almashtirish / 🚫 Hech qachon on one preview post.
async function randomItemAction(cb, answer, op, id, idx) {
  return withSelectionLock(id, async () => {
    const sel = await db.getSelection(id);
    if (!sel || sel.kind !== 'random') {
      return answer('Bu tanlov eskirgan — qaytadan tanlang.', true);
    }
    const slot = sel.slots[Number(idx)];
    if (!slot || slot.removed) {
      return answer('Bu mahsulot allaqachon olib tashlangan.');
    }
    const s = await db.getSettings();
    const target = { chat_id: sel.chat_id, message_id: slot.msg_id };
    if (op === 'r') {
      const [item] = await pickRandomProducts(1, {
        repeatDays: db.limit(s, 'random_repeat_days'),
        exclude: sel.slots.map((x) => x.item.sku),
      });
      if (!item) {
        return answer('Boshqa mos mahsulot topilmadi.', true);
      }
      await tg('editMessageMedia', {
        ...target,
        media: { type: 'photo', media: item.image_url, caption: buildPostCaption(item, s.phone), parse_mode: 'HTML' },
        reply_markup: itemKeyboard(id, idx),
      });
      slot.item = item;
      await db.saveSelection(id, sel);
      await answer('🔄 Almashtirildi');
      return updateRandomControl(id, sel, s);
    }
    if (op === 'b') {
      await db.addRandomBlacklist(slot.item);
    }
    slot.removed = true;
    await db.saveSelection(id, sel);
    await tg('deleteMessage', target).catch(() =>
      tg('editMessageCaption', { ...target, caption: '❌ Olib tashlandi', reply_markup: { inline_keyboard: [] } }).catch(() => {}),
    );
    await answer(op === 'b' ? "🚫 Random'dan butunlay chiqarildi" : '❌ Olib tashlandi');
    return updateRandomControl(id, sel, s);
  });
}

// Preview: SKU selections as they will look (albums of up to 10); random selections as one post per
// product with its own buttons. Then one control message with the action buttons.
async function showSelection(chatId, { items, notes = [], kind, n }) {
  if (!items.length) {
    return say(chatId, ["❌ Joylash uchun mos mahsulot topilmadi.", ...notes].join('\n'));
  }
  if (kind === 'random') {
    return showRandomSelection(chatId, items, n);
  }
  const s = await db.getSettings();
  const id = newSelectionId();
  await db.saveSelection(id, { items, kind, n });
  const header = `🔖 ${items.length} ta mahsulot: ${items.map((i) => i.sku).join(', ')}`;
  const text = [header, ...items.map((i) => (items.length === 1 ? `📦 Qoldiq: ${i.stock}` : null)).filter(Boolean), ...notes].join('\n');
  const kb = selectionKeyboard(id, kind, await storyProfileCount(s));
  if (items.length === 1) {
    return tg('sendPhoto', {
      chat_id: chatId,
      photo: items[0].image_url,
      caption: `${buildPostCaption(items[0], s.phone)}\n\n${text}`,
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }
  for (const group of chunk(items, 10)) {
    if (group.length === 1) {
      await tg('sendPhoto', { chat_id: chatId, photo: group[0].image_url, caption: buildPostCaption(group[0], s.phone), parse_mode: 'HTML' });
    } else {
      await tg('sendMediaGroup', {
        chat_id: chatId,
        media: group.map((i) => ({ type: 'photo', media: i.image_url, caption: buildPostCaption(i, s.phone), parse_mode: 'HTML' })),
      });
    }
  }
  return say(chatId, text, { reply_markup: kb });
}

async function selectionAction(cb, answer, action, id) {
  const chatId = cb.message.chat.id;
  const sel = await db.getSelection(id);
  if (!sel) {
    return answer('Bu tanlov eskirgan — qaytadan yuboring.', true);
  }
  const s = await db.getSettings();
  const items = selectionItems(sel);
  const isRandom = sel.kind === 'random';
  const clearButtons = () =>
    tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(
      () => {},
    );
  const errorsText = (errors) => (errors.length ? `\n❗ ${errors.slice(0, 5).join('\n❗ ')}` : '');

  if (action === 'x') {
    await answer('Bekor qilindi');
    await clearButtons();
    if (isRandom) await closeRandomPreviews(sel);
    await db.deleteSelection(id);
    return say(chatId, '❌ Bekor qilindi.');
  }
  if (action === 'r') {
    await answer('🔄 Boshqasi tanlanmoqda...');
    await clearButtons();
    await db.deleteSelection(id);
    if (isRandom) await closeRandomPreviews(sel, { remove: true });
    const next = await pickRandomProducts(sel.n, {
      repeatDays: db.limit(s, 'random_repeat_days'),
      exclude: (isRandom ? sel.slots.map((x) => x.item) : items).map((i) => i.sku),
    });
    return showSelection(chatId, { items: next, kind: 'random', n: sel.n });
  }
  if (!items.length) {
    return answer("Tanlov bo'sh — avval mahsulot tanlang.", true);
  }
  if (action === 't') {
    await answer('🧪 Test yuborilmoqda...');
    const r = await postItemsTest(items, s, chatId, { album: !isRandom || randomAlbum(s) });
    return say(chatId, `🧪 Test: ${r.posted}/${items.length} ta faqat sizga yuborildi.${errorsText(r.errors)}`);
  }
  if (!(await db.once(`sel:${id}`, 60 * 60 * 6))) {
    return answer('Allaqachon bajarilgan', true);
  }
  await answer('⏳ Joylanmoqda...');
  await clearButtons();
  if (isRandom) await closeRandomPreviews(sel);
  const lines = [];
  if (action === 'c' || action === 'b') {
    const r = await postItemsNow(items, s, { album: !isRandom || randomAlbum(s) });
    lines.push(
      r.channels
        ? `📢 Kanal: ${r.posted.length}/${items.length} ta mahsulot ${r.channels} ta kanalga joylandi.${errorsText(r.errors)}`
        : "❌ Faol kanal yo'q.",
    );
    if (r.queued.length) {
      lines.push(`⏳ ${r.queued.length} tasi navbatga o'tdi — keyingi tick'da joylanadi.`);
    }
  }
  if (action === 's' || action === 'b') {
    const r = await postStoriesNow(items, s);
    lines.push(...storySummary(r, items.length, s));
  }
  if (isRandom) {
    await db.addRandomHist(items.map((i) => i.sku));
  }
  await db.deleteSelection(id);
  return say(chatId, lines.join('\n'));
}

// ---- random blacklist view ----

const BLACKLIST_PAGE = 15;

async function blacklistView(page = 0) {
  const list = await db.getRandomBlacklist();
  const pages = Math.max(1, Math.ceil(list.length / BLACKLIST_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = list
    .slice(p * BLACKLIST_PAGE, (p + 1) * BLACKLIST_PAGE)
    .map((b) => [btn(`↩️ ${b.sku} — ${String(b.name || '').slice(0, 40)}`, `bl:u:${b.sku}:${p}`.slice(0, 64))]);
  const nav = [];
  if (p > 0) nav.push(btn('⬅️', `bl:p:${p - 1}`));
  if (p < pages - 1) nav.push(btn('➡️', `bl:p:${p + 1}`));
  return {
    text: list.length
      ? `🚫 <b>Random qora ro'yxat</b> (${list.length} ta${pages > 1 ? `, ${p + 1}/${pages}-sahifa` : ''})\n\nBu mahsulotlar random'da (kunlik 16:00 ham) hech qachon tanlanmaydi. Qaytarish uchun mahsulotni bosing.`
      : "🚫 <b>Random qora ro'yxat</b>\n\nRo'yxat bo'sh. Random preview'dagi \"🚫 Hech qachon\" tugmasi mahsulotni shu yerga qo'shadi.",
    reply_markup: { inline_keyboard: [...rows, ...(nav.length ? [nav] : []), back] },
  };
}

// ---- pending input ----

async function handlePending(msg, pending) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (pending.type === 'phone') {
    const phone = text.replace(/[\s()-]/g, '');
    if (!PHONE_RE.test(phone)) {
      return say(chatId, "❌ Noto'g'ri raqam. Masalan: +998901234567");
    }
    await db.updateSettings({ phone: phone.startsWith('+') ? phone : `+${phone}` });
  } else if (pending.type === 'order_url') {
    if (!/^https?:\/\/\S+$/.test(text)) {
      return say(chatId, "❌ Havola https:// bilan boshlanishi kerak. Masalan: https://t.me/username");
    }
    await db.updateSettings({ order_url: text });
  } else if (pending.type === 'limit') {
    const l = db.LIMITS[pending.field];
    const value = Number(text);
    if (!l || !/^\d+$/.test(text) || value < l.min || value > l.max) {
      return say(chatId, `❌ ${l.min} dan ${l.max} gacha butun son yuboring. Qayta yuboring:`);
    }
    await db.updateSettings({ [pending.field]: value });
    await db.clearPending(msg.from.id);
    await say(chatId, '✅ Saqlandi.');
    return show(chatId, null, await limitsView());
  } else if (pending.type === 'random_n') {
    const n = Number(text);
    if (!/^\d+$/.test(text) || n < 1 || n > RANDOM_MAX) {
      return say(chatId, `❌ 1 dan ${RANDOM_MAX} gacha son yuboring. Qayta yuboring:`);
    }
    await db.clearPending(msg.from.id);
    await say(chatId, '⏳ Tanlanmoqda...');
    const s = await db.getSettings();
    const items = await pickRandomProducts(n, { repeatDays: db.limit(s, 'random_repeat_days') });
    return showSelection(chatId, { items, kind: 'random', n });
  } else if (pending.type === 'channel') {
    if (!/^(@[A-Za-z0-9_]{4,}|-100\d+)$/.test(text)) {
      return say(chatId, '❌ Kanalni @username yoki -100... ID ko\'rinishida yuboring.');
    }
    let chat;
    try {
      chat = await tg('getChat', { chat_id: text });
    } catch (e) {
      return say(chatId, `❌ Kanal topilmadi yoki bot unga admin emas: ${errText(e)}`);
    }
    const s = await db.getSettings();
    const id = String(chat.id);
    if (!s.channels.some((c) => String(c.id) === id || c.id === text)) {
      await db.updateSettings({ channels: [...s.channels, { id, title: chat.title || text, active: true }] });
    }
  }
  await db.clearPending(msg.from.id);
  await say(chatId, '✅ Saqlandi.');
  return show(chatId, null, pending.type === 'channel' ? await channelsView() : await menuView());
}

async function runNow(chatId) {
  const t = await runTick({ budgetMs: INTERACTIVE_BUDGET_MS });
  if (t.skipped) {
    return say(chatId, "⏳ Hozir boshqa joylash jarayoni ishlayapti, birozdan keyin urinib ko'ring.");
  }
  return say(
    chatId,
    `🚀 <b>Hozir joylash</b>\n\n` +
      `🆕 Yangi topildi: ${t.detected.found}\n` +
      `🔥 Chegirma: ${t.discounts.discount}, ♻️ yana sotuvda: ${t.discounts.restock}\n` +
      `✅ Kanalga joylandi: ${t.channel.posted}${t.channel.failed ? `, xato: ${t.channel.failed}` : ''}\n` +
      `📱 Story: ${t.stories.new}, chegirma story: ${t.stories.discount}\n` +
      `📦 Navbatda: kanal ${t.queue}, story ${t.story_queue}`,
  );
}

const randomPrompt = () => promptView(`🎲 Nechta mahsulot? (1-${RANDOM_MAX})`);

async function runShortcut(action, msg, text) {
  const chatId = msg.chat.id;
  if (action === 'panel') {
    // Show the reply keyboard on /start and the first time; afterwards it stays.
    if (/^\/start/.test(text) || (await db.once(`kb:${msg.from.id}`, 60 * 60 * 24 * 365))) {
      await say(chatId, '👇 Pastdagi tugmalar doim shu yerda turadi.');
    }
    return show(chatId, null, await menuView());
  }
  if (action === 'random') {
    await db.setPending(msg.from.id, { type: 'random_n' });
    return show(chatId, null, randomPrompt());
  }
  if (action === 'report') {
    return say(chatId, await buildReport());
  }
  await say(chatId, '⏳ Joylanmoqda...');
  return runNow(chatId);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (msg.chat.type !== 'private') {
    return;
  }
  if (!isAdmin(msg.from?.id)) {
    // Customers: contact info and the order button only.
    const s = await db.getSettings();
    return tg('sendMessage', {
      chat_id: chatId,
      text: `Buyurtma uchun: ${s.phone}`,
      reply_markup: { inline_keyboard: [[{ text: '🛒 Buyurtma berish', url: s.order_url }]] },
    });
  }
  const shortcut = adminShortcut(text);
  if (shortcut) {
    await db.clearPending(msg.from.id);
    return runShortcut(shortcut, msg, text);
  }
  const pending = await db.getPending(msg.from.id);
  if (pending) {
    return handlePending(msg, pending);
  }
  if (SKU_LIST_RE.test(text)) {
    const skus = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
    if (skus.length > MAX_SKUS) {
      return say(chatId, `❌ Bir martada ko'pi bilan ${MAX_SKUS} ta SKU yuboring.`);
    }
    return showSelection(chatId, { ...(await loadSkuItems(skus)), kind: 'sku' });
  }
  return say(chatId, 'SKU yuboring (masalan 670897 yoki "670899, 670868") yoki pastdagi tugmalardan foydalaning.');
}

// ---- callbacks ----

async function toggle(field) {
  const s = await db.getSettings();
  await db.updateSettings({ [field]: !s[field] });
}

async function handleCallback(cb) {
  const data = cb.data || '';
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  if (!isAdmin(cb.from.id)) {
    return answer("Ruxsat yo'q", true);
  }
  const [cmd, arg, arg2] = data.split(':');

  switch (cmd) {
    case 'm':
      await db.clearPending(cb.from.id);
      await answer();
      return show(chatId, messageId, await menuView());
    case 'ph': {
      const s = await db.getSettings();
      await db.setPending(cb.from.id, { type: 'phone' });
      await answer();
      return show(chatId, messageId, promptView(`📞 Hozirgi raqam: ${s.phone}\n\nYangi telefon raqamini yuboring (masalan +998901234567):`));
    }
    case 'ou': {
      const s = await db.getSettings();
      await db.setPending(cb.from.id, { type: 'order_url' });
      await answer();
      return show(chatId, messageId, promptView(`🛒 Hozirgi havola: ${s.order_url}\n\nYangi havolani yuboring (masalan https://t.me/username):`));
    }
    case 'ch':
      await answer();
      return show(chatId, messageId, await channelsView());
    case 'cha':
      await db.setPending(cb.from.id, { type: 'channel' });
      await answer();
      return show(
        chatId,
        messageId,
        promptView("📢 Kanal @username yoki -100... ID sini yuboring.\n\nAvval botni kanalga admin qilib qo'shing."),
      );
    case 'cht':
    case 'chd': {
      const s = await db.getSettings();
      const i = Number(arg);
      if (s.channels[i]) {
        const channels =
          cmd === 'chd'
            ? s.channels.filter((_, j) => j !== i)
            : s.channels.map((c, j) => (j === i ? { ...c, active: !c.active } : c));
        await db.updateSettings({ channels });
      }
      await answer();
      return show(chatId, messageId, await channelsView());
    }
    case 'tr':
      await toggle('random_album');
      break;
    case 'tnc':
      await toggle('new_channel');
      break;
    case 'trv': {
      const s = await db.getSettings();
      await db.updateSettings({ random_view: randomAlbum(s) ? 'single' : 'album' });
      break;
    }
    case 'tdc':
      await toggle('discount_channel');
      break;
    case 'ta':
      await toggle('album');
      break;
    case 'tns':
    case 'tds':
    case 'trs': {
      const field = { tns: 'new_story', tds: 'discount_story', trs: 'random_story' }[cmd];
      const s = await db.getSettings();
      if (!s[field] && !db.storyProfiles(s, await db.listBiz()).length) {
        return answer("Avval botni Telegram Business'ga ulang (Settings → Telegram Business → Chatbots).", true);
      }
      await db.updateSettings({ [field]: !s[field] });
      break;
    }
    case 'lm': {
      await answer();
      if (!arg) {
        return show(chatId, messageId, await limitsView());
      }
      const l = db.LIMITS[arg];
      if (!l) {
        return null;
      }
      const s = await db.getSettings();
      await db.setPending(cb.from.id, { type: 'limit', field: arg });
      return show(
        chatId,
        messageId,
        promptView(`${LIMIT_LABELS[arg]}\nHozirgi qiymat: ${db.limit(s, arg)}\n\nYangi qiymatni yuboring (${l.min}–${l.max}):`),
      );
    }
    case 'rj':
      await db.setPending(cb.from.id, { type: 'random_n' });
      await answer();
      return show(chatId, messageId, randomPrompt());
    case 'bz': {
      if (arg) {
        const id = data.slice(3);
        const s = await db.getSettings();
        const biz = await db.listBiz();
        const on_ = db.storyProfiles(s, biz).some((p) => p.id === id);
        await db.updateSettings({ story_bcs: { ...(s.story_bcs || {}), [id]: !on_ } });
        await answer(on_ ? "❌ Story'lar bu profilga yuborilmaydi" : "✅ Story'lar bu profilga ham yuboriladi");
      } else {
        await answer();
      }
      return show(chatId, messageId, await bizView());
    }
    case 'rep':
      await answer();
      return say(chatId, await buildReport());
    case 'now':
      await answer('⏳ Joylanmoqda...');
      return runNow(chatId);
    case 'sel':
      return selectionAction(cb, answer, arg, arg2);
    case 'ri':
      return randomItemAction(cb, answer, arg, arg2, data.split(':')[3]);
    case 'bl': {
      if (arg === 'u') {
        await db.removeRandomBlacklist(arg2);
        await answer(`↩️ ${arg2} random'ga qaytarildi`);
        return show(chatId, messageId, await blacklistView(Number(data.split(':')[3]) || 0));
      }
      await answer();
      return show(chatId, messageId, await blacklistView(arg === 'p' ? Number(arg2) : 0));
    }
    default:
      return answer();
  }
  // toggles fall through here
  await answer('Saqlandi');
  return show(chatId, messageId, await menuView());
}

async function handleBusinessConnection(c) {
  const prev = await db.saveBiz(c);
  const who = db.bizLabel(c);
  let text;
  if (!c.is_enabled) {
    text = `🔌 Biznes profil uzildi: ${who}`;
  } else {
    // A newly connected (or reconnected) profile gets stories right away.
    const s = await db.getSettings();
    await db.updateSettings({ story_bcs: { ...(s.story_bcs || {}), [c.id]: true } });
    const canStories = c.rights ? c.rights.can_manage_stories !== false : true;
    text =
      `🔗 ${prev ? 'Profil qayta ulandi' : 'Yangi profil ulandi'}: ${who}\nID: <code>${c.id}</code>\n` +
      (canStories
        ? "📱 Story'lar bu profilga ham yuboriladi."
        : "⚠️ Botda story ruxsati yo'q — Telegram Business → Chatbots → ruxsatlarda story'larni boshqarishni yoqing.");
  }
  await notifyAdmins({ text, parse_mode: 'HTML' });
}

export async function handleUpdate(update) {
  if (update.business_connection) {
    return handleBusinessConnection(update.business_connection);
  }
  if (update.callback_query) {
    return handleCallback(update.callback_query);
  }
  if (update.message) {
    return handleMessage(update.message);
  }
}
