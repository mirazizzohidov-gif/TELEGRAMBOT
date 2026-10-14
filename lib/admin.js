import { findBySku, findPrice, productImage, productStock, toItem } from './bito.js';
import { buildPostCaption } from './caption.js';
import { pickRandomProducts } from './daily.js';
import { postItemsNow, postItemsTest, postStoriesNow, randomAlbum } from './poster.js';
import { buildReport, notifyAdmins } from './report.js';
import * as db from './store.js';
import { postProductStory } from './story.js';
import { tg } from './telegram.js';
import { runTick } from './tick.js';
import { chunk, errText, isAdmin } from './util.js';

const on = (v) => (v ? '✅' : '❌');
const btn = (text, data) => ({ text, callback_data: data });
const back = [btn('⬅️ Orqaga', 'm')];
const SKU_LIST_RE = /^\d[\d-]*(?:[\s,]+\d[\d-]*)*$/;
const MAX_SKUS = 30;
const RANDOM_MAX = 30;
const PHONE_RE = /^\+?\d{9,15}$/;
const INTERACTIVE_BUDGET_MS = 50000;

const bizLabel = (b) =>
  b ? (b.user?.username ? `@${b.user.username}` : b.user?.first_name || b.id) + (b.is_enabled === false ? ' (o\'chiq)' : '') : '';

async function menuView() {
  const [s, biz, queue, storyQueue, st] = await Promise.all([
    db.getSettings(),
    db.listBiz(),
    db.queueLength(),
    db.storyQueueLength(),
    db.getStats(),
  ]);
  const active = s.channels.filter((c) => c.active).length;
  const bcId = db.storyConnectionId(s, biz);
  const bcName = bizLabel(biz.find((b) => b.id === bcId)) || (bcId ? 'env' : "yo'q");
  return {
    text:
      `⚙️ <b>Admin panel</b>\n\n` +
      `📦 Navbatda: kanal ${queue}, story ${storyQueue}\n` +
      `✅ Bugun kanalga joylangan: ${st.posted || 0}\n` +
      `📱 Bugun story: ${st.stories || 0}/${db.storyDailyLimit(s)}\n` +
      `🔥 Bugun chegirma story: ${st.discount_stories || 0}/${db.discountStoryLimit(s)}`,
    reply_markup: {
      inline_keyboard: [
        [btn(`🎲 Random albom: ${on(s.random_album)}`, 'tr'), btn(`🎲 Random → story: ${on(s.random_story)}`, 'trs')],
        [btn(`🎲 Random ko'rinishi: ${randomAlbum(s) ? 'Albom' : 'Alohida'}`, 'trv')],
        [btn(`🆕 Yangi mahsulot → kanal: ${on(s.new_channel)}`, 'tnc')],
        [btn(`🆕 Yangi mahsulot → story: ${on(s.new_story)}`, 'tns')],
        [btn(`🔥 Chegirma → kanal: ${on(s.discount_channel)}`, 'tdc')],
        [btn(`🔥 Chegirma → story: ${on(s.discount_story)}`, 'tds')],
        [btn(`Albom rejimi: ${on(s.album)}`, 'ta')],
        [btn('⚙️ Limitlar', 'lm'), btn(`📱 Profil: ${bcName}`, 'bz')],
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
  const current = db.storyConnectionId(s, biz);
  const rows = biz.map((b) => [btn(`${b.id === current ? '🔘' : '⚪️'} ${bizLabel(b)}`, `bz:${b.id}`.slice(0, 64))]);
  return {
    text: biz.length
      ? '📱 <b>Story uchun biznes profil</b>\n\nRo\'yxatdan tanlang:'
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

const say = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

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

function selectionKeyboard(id, kind) {
  const rows =
    kind === 'random'
      ? [
          [btn('📢 Kanalga', `sel:c:${id}`), btn('📱 Story', `sel:s:${id}`)],
          [btn('📢+📱 Ikkalasi', `sel:b:${id}`), btn('🧪 Test (faqat menga)', `sel:t:${id}`)],
          [btn('🔄 Boshqa tanlash', `sel:r:${id}`), btn('❌ Bekor', `sel:x:${id}`)],
        ]
      : [
          [btn('📢 Kanalga joylash', `sel:c:${id}`), btn('📱 Story', `sel:s:${id}`)],
          [btn('📢+📱 Ikkalasi', `sel:b:${id}`), btn('🧪 Test (faqat menga)', `sel:t:${id}`)],
          [btn('❌ Bekor', `sel:x:${id}`)],
        ];
  return { inline_keyboard: rows };
}

// Preview: the posts as they will look (albums of up to 10, or separate posts for random in
// "Alohida" view), then the action buttons.
async function showSelection(chatId, { items, notes = [], kind, n }) {
  if (!items.length) {
    return say(chatId, ["❌ Joylash uchun mos mahsulot topilmadi.", ...notes].join('\n'));
  }
  const s = await db.getSettings();
  const id = newSelectionId();
  await db.saveSelection(id, { items, kind, n });
  const header =
    kind === 'random'
      ? `🎲 Tasodifiy ${items.length} ta mahsulot`
      : `🔖 ${items.length} ta mahsulot: ${items.map((i) => i.sku).join(', ')}`;
  const text = [header, ...items.map((i) => (items.length === 1 ? `📦 Qoldiq: ${i.stock}` : null)).filter(Boolean), ...notes].join('\n');
  const kb = selectionKeyboard(id, kind);
  if (kind === 'random' && !randomAlbum(s)) {
    // Separate posts, as they will appear in the channel, then one control message.
    for (const item of items) {
      await tg('sendPhoto', { chat_id: chatId, photo: item.image_url, caption: buildPostCaption(item, s.phone), parse_mode: 'HTML' });
    }
    return say(chatId, text, { reply_markup: kb });
  }
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
  const clearButtons = () =>
    tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(
      () => {},
    );
  const errorsText = (errors) => (errors.length ? `\n❗ ${errors.slice(0, 5).join('\n❗ ')}` : '');

  if (action === 'x') {
    await answer('Bekor qilindi');
    await clearButtons();
    await db.deleteSelection(id);
    return say(chatId, '❌ Bekor qilindi.');
  }
  if (action === 't') {
    await answer('🧪 Test yuborilmoqda...');
    const r = await postItemsTest(sel.items, s, chatId, { album: sel.kind !== 'random' || randomAlbum(s) });
    return say(chatId, `🧪 Test: ${r.posted}/${sel.items.length} ta faqat sizga yuborildi.${errorsText(r.errors)}`);
  }
  if (action === 'r') {
    await answer('🔄 Boshqasi tanlanmoqda...');
    await clearButtons();
    await db.deleteSelection(id);
    const items = await pickRandomProducts(sel.n, {
      repeatDays: db.limit(s, 'random_repeat_days'),
      exclude: sel.items.map((i) => i.sku),
    });
    return showSelection(chatId, { items, kind: 'random', n: sel.n });
  }
  if (!(await db.once(`sel:${id}`, 60 * 60 * 6))) {
    return answer('Allaqachon bajarilgan', true);
  }
  await answer('⏳ Joylanmoqda...');
  await clearButtons();
  const lines = [];
  if (action === 'c' || action === 'b') {
    const r = await postItemsNow(sel.items, s, { album: sel.kind !== 'random' || randomAlbum(s) });
    if (sel.kind === 'random') {
      await db.addRandomHist(sel.items.map((i) => i.sku));
    }
    lines.push(
      r.channels
        ? `📢 Kanal: ${r.posted.length}/${sel.items.length} ta mahsulot ${r.channels} ta kanalga joylandi.${errorsText(r.errors)}`
        : "❌ Faol kanal yo'q.",
    );
    if (r.queued.length) {
      lines.push(`⏳ ${r.queued.length} tasi navbatga o'tdi — keyingi tick'da joylanadi.`);
    }
  }
  if (action === 's' || action === 'b') {
    const r = await postStoriesNow(sel.items, s);
    if (sel.kind === 'random' && action === 's') {
      await db.addRandomHist(sel.items.map((i) => i.sku));
    }
    if (r.reason) {
      lines.push(`📱 Story: ❌ ${r.reason}`);
    } else {
      lines.push(`📱 Story: ${r.posted.length}/${sel.items.length} ta joylandi.`);
      if (r.queued) {
        lines.push(
          r.stopped
            ? `⏳ ${r.queued} tasi xato tufayli navbatda — keyinroq qayta uriniladi.`
            : `⏳ ${r.queued} tasi kunlik limit (${db.storyDailyLimit(s)}) tufayli navbatda — keyingi kun(lar)da chiqadi.`,
        );
      }
      lines.push(...r.errors);
    }
  }
  await db.deleteSelection(id);
  return say(chatId, lines.join('\n'));
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

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!isAdmin(msg.from?.id)) {
    if (msg.chat.type === 'private' && /^\/start\b/.test(text)) {
      await say(chatId, 'Bu bot faqat adminlar uchun.');
    }
    return;
  }
  if (msg.chat.type !== 'private') {
    return;
  }
  if (/^\/(start|admin|cancel)\b/.test(text)) {
    await db.clearPending(msg.from.id);
    return show(chatId, null, await menuView());
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
  return say(chatId, 'SKU yuboring (masalan 670897 yoki "670899, 670868") yoki /admin ni bosing.');
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
      if (!s[field] && !db.storyConnectionId(s, await db.listBiz())) {
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
      return show(chatId, messageId, promptView(`🎲 Nechta mahsulot? (1-${RANDOM_MAX})`));
    case 'bz':
      if (arg) {
        await db.updateSettings({ story_bc: data.slice(3) });
        break;
      }
      await answer();
      return show(chatId, messageId, await bizView());
    case 'rep':
      await answer();
      return say(chatId, await buildReport());
    case 'now': {
      await answer('⏳ Joylanmoqda...');
      const t = await runTick({ budgetMs: INTERACTIVE_BUDGET_MS });
      if (t.skipped) {
        return say(chatId, '⏳ Hozir boshqa joylash jarayoni ishlayapti, birozdan keyin urinib ko\'ring.');
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
    case 'sel':
      return selectionAction(cb, answer, arg, arg2);
    default:
      return answer();
  }
  // toggles fall through here
  await answer('Saqlandi');
  return show(chatId, messageId, await menuView());
}

async function handleBusinessConnection(c) {
  await db.saveBiz(c);
  const who = bizLabel({ ...c, is_enabled: true });
  await notifyAdmins({
    text: c.is_enabled ? `🔗 Biznes profil ulandi: ${who}\nID: <code>${c.id}</code>` : `🔌 Biznes profil uzildi: ${who}`,
    parse_mode: 'HTML',
  });
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
