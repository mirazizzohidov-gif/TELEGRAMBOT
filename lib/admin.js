import { findBySku, findPrice, productImage, productStock, toItem } from './bito.js';
import { buildPostCaption } from './caption.js';
import { collectToday, queueRandom } from './daily.js';
import { postItemNow, runTick } from './poster.js';
import { buildReport, notifyAdmins } from './report.js';
import * as db from './store.js';
import { postProductStory } from './story.js';
import { tg } from './telegram.js';
import { errText, isAdmin } from './util.js';

const on = (v) => (v ? '✅' : '❌');
const btn = (text, data) => ({ text, callback_data: data });
const back = [btn('⬅️ Orqaga', 'm')];
const SKU_RE = /^\d[\d-]*$/;
const PHONE_RE = /^\+?\d{9,15}$/;
const INTERACTIVE_BUDGET_MS = 50000;

const bizLabel = (b) =>
  b ? (b.user?.username ? `@${b.user.username}` : b.user?.first_name || b.id) + (b.is_enabled === false ? ' (o\'chiq)' : '') : '';

async function menuView() {
  const [s, biz, queue, st] = await Promise.all([db.getSettings(), db.listBiz(), db.queueLength(), db.getStats()]);
  const active = s.channels.filter((c) => c.active).length;
  const bcId = db.storyConnectionId(s, biz);
  const bcName = bizLabel(biz.find((b) => b.id === bcId)) || (bcId ? 'env' : "yo'q");
  return {
    text:
      `⚙️ <b>Admin panel</b>\n\n` +
      `📦 Navbatda: ${queue} ta\n` +
      `✅ Bugun joylangan: ${st.posted || 0} ta\n` +
      `📱 Bugungi story: ${st.stories || 0}/${db.storyDailyLimit()}`,
    reply_markup: {
      inline_keyboard: [
        [btn(`📞 Telefon: ${s.phone}`, 'ph')],
        [btn('🛒 Buyurtma havolasi', 'ou')],
        [btn(`📢 Kanallar (${active}/${s.channels.length} faol)`, 'ch')],
        [btn(`Kanalga yuborish: ${on(s.send_channel)}`, 'ts')],
        [btn(`Story: ${on(s.story)}`, 'tst'), btn(`📱 Profil: ${bcName}`, 'bz')],
        [btn(`Albom rejimi: ${on(s.album)}`, 'ta')],
        [btn(`🎲 Random rejim: ${on(s.random)}`, 'tr')],
        [btn('🚀 Hozir joylash', 'now')],
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

// ---- SKU preview ----

async function loadItem(sku) {
  const p = await findBySku(sku);
  if (!p) {
    return { error: `❌ SKU <b>${sku}</b> BITO'da topilmadi.` };
  }
  const amount = await findPrice(p._id);
  return { product: p, amount, item: toItem(p, amount || 0) };
}

async function sendPreview(chatId, sku) {
  const { error, product, amount, item } = await loadItem(sku);
  if (error) {
    return say(chatId, error);
  }
  const [sent, s] = await Promise.all([db.getSent(sku), db.getSettings()]);
  const notes = [`🔖 SKU: ${sku}`, `📦 Qoldiq: ${productStock(product)}`];
  if (!(amount > 0)) notes.push("⚠️ Narx yo'q");
  if (productStock(product) <= 0) notes.push('⚠️ Qoldiq 0');
  if (sent) notes.push(`ℹ️ Avval yuborilgan: ${sent.date}`);
  const canPost = productImage(product) && amount > 0;
  const kb = {
    inline_keyboard: canPost
      ? [[btn('✅ Kanalga joylash', `pv:c:${sku}`), btn('📱 Story', `pv:s:${sku}`)], [btn('❌ Bekor', 'pv:x')]]
      : [[btn('❌ Bekor', 'pv:x')]],
  };
  const caption = `${amount > 0 ? buildPostCaption(item, s.phone) : `🛍 ${item.name}`}\n\n${notes.join('\n')}`;
  if (!productImage(product)) {
    return say(chatId, `${caption}\n⚠️ Rasm yo'q`, { reply_markup: kb });
  }
  return tg('sendPhoto', { chat_id: chatId, photo: item.image_url, caption, parse_mode: 'HTML', reply_markup: kb });
}

async function previewAction(chatId, messageId, action, sku) {
  await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(
    () => {},
  );
  if (action === 'x') {
    return;
  }
  const { error, amount, item } = await loadItem(sku);
  if (error || !(amount > 0)) {
    return say(chatId, error || "❌ Narx topilmadi, joylab bo'lmaydi.");
  }
  const s = await db.getSettings();
  if (action === 'c') {
    const r = await postItemNow(item, s);
    return say(chatId, r.ok ? `✅ ${r.channels} ta kanalga joylandi.` : `❌ Joylanmadi: ${r.errors.join('; ')}`);
  }
  const bc = db.storyConnectionId(s, await db.listBiz());
  if (!bc) {
    return say(chatId, "❌ Biznes ulanish yo'q. Avval botni Telegram Business'ga ulang.");
  }
  try {
    await postProductStory({ businessConnectionId: bc, imageUrl: item.image_url, caption: buildPostCaption(item, s.phone), parseMode: 'HTML' });
    await db.incrStat('stories');
    return say(chatId, '✅ Story joylandi.');
  } catch (e) {
    return say(chatId, `❌ Story xatosi: ${errText(e)}`);
  }
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
  if (SKU_RE.test(text)) {
    return sendPreview(chatId, text);
  }
  return say(chatId, 'SKU yuboring (masalan 670897) yoki /admin ni bosing.');
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
    case 'ts':
      await toggle('send_channel');
      break;
    case 'ta':
      await toggle('album');
      break;
    case 'tr':
      await toggle('random');
      break;
    case 'tst': {
      const s = await db.getSettings();
      if (!s.story && !db.storyConnectionId(s, await db.listBiz())) {
        return answer("Avval botni Telegram Business'ga ulang (Settings → Telegram Business → Chatbots).", true);
      }
      await db.updateSettings({ story: !s.story });
      break;
    }
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
      const c = await collectToday();
      const t = await runTick({ budgetMs: INTERACTIVE_BUDGET_MS });
      return say(
        chatId,
        `🚀 <b>Hozir joylash</b>\n\nBugungi yangi: ${c.found}, navbatga qo'yildi: ${c.queued}\n` +
          `Joylandi: ${t.posted}, story: ${t.stories}${t.failed ? `, xato: ${t.failed}` : ''}\n` +
          `Navbatda qoldi: ${await db.queueLength()}`,
      );
    }
    case 'rnd': {
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      if (arg !== 'y') {
        await answer('Bekor qilindi');
        return say(chatId, "❌ Bugun tasodifiy mahsulot joylanmaydi.");
      }
      if (!(await db.once(`random_done:${db.today()}`))) {
        return answer('Bugun allaqachon bajarilgan', true);
      }
      await answer('⏳ Tanlanmoqda...');
      const queued = await queueRandom(10);
      const t = await runTick({ budgetMs: INTERACTIVE_BUDGET_MS });
      return say(chatId, `🎲 ${queued} ta tasodifiy mahsulot navbatga qo'yildi, ${t.posted} tasi joylandi. Qolgani navbat bilan joylanadi.`);
    }
    case 'pv':
      await answer();
      return previewAction(chatId, messageId, arg, arg2);
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
