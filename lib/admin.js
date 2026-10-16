import { findBySku, findLatest, formatPrice, loadDiscounts, priceFor, productImage, productStock, toItem } from './bito.js';
import { buildPostCaption } from './caption.js';
import { ch2Contact, ch2Label, ch2PriceLine, normOrderTarget, normPhone2, ch2QueueLength, ch2ReportLine, checkChannel2, channel2Owner, DEFAULT_MARKUP, isChannel2Owner, markupOf, markupPrice, MARKUP_MAX, MARKUP_MIN } from './channel2.js';
import { pickRandomProducts } from './daily.js';
import { postItemsNow, postItemsTest, postStoriesNow, postStoryToAll, storyErrorHint, storyLine, storySummary } from './poster.js';
import { buildReport, notifyAdmins } from './report.js';
import { aiConfigured, aiModel, describe, dropDesc, generateDesc, getDesc, setDesc, withDescriptions } from './ai.js';
import { handleNameSearch, handlePhotoSearch } from './photosearch.js';
import { handleCatalogCallback } from './catalog.js';
import { healthReport } from './health.js';
import { applyWatermark, dropLogo, getLogo, LOGO_MAX_BYTES, OPACITIES, opacityOf, POS_LABEL, POSITIONS, positionOf, saveLogo } from './watermark.js';
import { downloadImage } from './story.js';
import { activeHelper, FIELDS, getHelper, handleHelperCallback, handleHelperMessage, helperFields, helperName, listHelpers, parseHelperRef, POST_BUTTON, removeHelper, saveHelper } from './helpers.js';
import { checkTarget, collectDay, datePost, dateTargets, daysAgo, getJob, parseDay, runDateJob, sentAlready, showDay, startJob } from './datesend.js';
import { handleOrderCallback, orderKb } from './orders.js';
import { restockQueueLength } from './restock.js';
import { reorderLines, reorderList, slowLines, slowMovers, weeklyReport } from './sales.js';
import { handleCustomerMessage, handleWaitCallback } from './waitlist.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { discountDetailsText } from './discount-watch.js';
import {
  connectGroup,
  handleGroupCallback,
  handleGroupMessage,
  handleMyChatMember,
  getScan,
  lowRecords,
  outRecords,
  scanCatalog,
  scanProgressText,
  scanStatusLines,
  sendStockReport,
  stockConfig,
} from './stock.js';
import { fmtDateTime, routeGroup, STOCK_ROUTES } from './stock.js';
import { runDiscountCheck, runTick } from './tick.js';
import { clock, errText, isAdmin, mapLimit } from './util.js';

const on = (v) => (v ? '✅' : '❌');
const btn = (text, data) => ({ text, callback_data: data });
const back = [btn('⬅️ Orqaga', 'm')];
const SKU_LIST_RE = /^\d[\d-]*(?:[\s,]+\d[\d-]*)*$/;
const MAX_SKUS = 30;
const RANDOM_MAX = 30;
const PHONE_RE = /^\+?\d{9,15}$/;
// The webhook already answered Telegram (waitUntil), so admin actions may use most of the 300 s.
const INTERACTIVE_BUDGET_MS = 240000;

// "⏳" messages get a note when an action takes long (BITO can be slow). Tests shorten it.
export const progressConfig = { slowAfterMs: 15000 };

const bizLabel = (b) => (b ? db.bizLabel(b) + (b.is_enabled === false ? " (o'chiq)" : '') : '');

// Number of business profiles stories go to (for button labels).
const storyProfileCount = async (s) => db.storyProfiles(s, await db.listBiz()).length;

async function menuView() {
  const [s, biz, queue, storyQueue, st, restockQueue] = await Promise.all([
    db.getSettings(),
    db.listBiz(),
    db.queueLength(),
    db.storyQueueLength(),
    db.getStats(),
    restockQueueLength(),
  ]);
  const active = s.channels.filter((c) => c.active).length;
  const profiles = db.storyProfiles(s, biz);
  const perProfile = (base, limit) =>
    profiles.length ? profiles.map((p) => `${p.label} ${st[`${base}:${p.id}`] || 0}/${limit}`).join(', ') : "profil yo'q";
  return {
    text:
      `⚙️ <b>Admin panel</b>\n\n` +
      `📦 Navbatda: kanal ${queue}, story ${storyQueue}, qayta keldi ${restockQueue}\n` +
      `✅ Bugun kanalga joylangan: ${st.posted || 0}\n` +
      `📱 Bugun story: ${perProfile('stories', db.storyDailyLimit(s))}\n` +
      `🔥 Bugun chegirma story: ${perProfile('discount_stories', db.discountStoryLimit(s))}`,
    reply_markup: {
      inline_keyboard: [
        [btn(`🎲 Kunlik random 16:00: ${on(s.random_album)}`, 'tr'), btn(`🎲 Random → story: ${on(s.random_story)}`, 'trs')],
        [btn(`🆕 Yangi mahsulot → kanal: ${on(s.new_channel)}`, 'tnc')],
        [btn(`🆕 Yangi mahsulot → guruh: ${s.new_group ? groupTitle(await db.listGroups(), s.new_group) : '❌'}`, 'ng')],
        [btn(`🆕 Yangi mahsulot → story: ${on(s.new_story)}`, 'tns')],
        [btn(`🔥 Chegirma → kanal: ${on(s.discount_channel)}`, 'tdc')],
        [btn(`🔥 Chegirma → story: ${on(s.discount_story)}`, 'tds')],
        [btn(`🔄 Qayta kelganlarni avtopost: ${on(s.restock_post)}`, 'trp')],
        [btn(`🌙 Qayta kelganlar kechasi ham: ${on(s.restock_night)}`, 'trn')],
        [btn(`🤖 AI tavsif: ${aiConfigured() ? on(s.ai_desc) : "❌ (kalit yo'q)"}`, 'ai')],
        [btn('⚙️ Limitlar', 'lm'), btn(`📸 Istoriya profillari (${profiles.length}/${biz.length || profiles.length})`, 'bz')],
        [btn("🚫 Random qora ro'yxat", 'bl')],
        [btn(`📞 Telefon: ${s.phone}`, 'ph')],
        [btn(`📢 Kanallar (${active}/${s.channels.length} faol)`, 'ch')],
        [btn(s.channel2?.id ? `📢 2-kanal: ${ch2Label(s.channel2)} ${on(s.channel2.enabled)} +${markupOf(s)}%` : '📢 2-kanal ulash', 'c2')],
        [btn('🛒 Buyurtma havolasi', 'ou')],
        [btn('🚀 Hozir joylash', 'now'), btn('🎲 Random joylash', 'rj')],
        [btn('🔥 Chegirmalarni hozir tekshirish', 'dcn')],
        [btn("📅 Sana bo'yicha yuborish", 'ds')],
        [btn('👥 Yordamchi adminlar', 'ha')],
        [btn("🧰 Qo'shimcha funksiyalar", 'xf'), btn('🩺 Holat', 'hl')],
        [btn("📷 Rasm bo'yicha qidirish", 'psq')],
        [btn('🛒 Buyurtmalar', 'ordv'), btn('📊 Savdo tahlili', 'sav')],
        [btn('📦 Ombor guruhi', 'sg')],
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

// "📢 2-kanal": the same posts with a markup price. Only the owner admin (channel2Owner) changes it.
async function channel2View(confirmDrop = false) {
  const s = await db.getSettings();
  const c = s.channel2;
  const owner = `\n\n🔒 O'zgartirish faqat admin ${channel2Owner()} uchun.`;
  if (!c?.id) {
    return {
      text:
        "📢 <b>2-kanal</b> — ulanmagan\n\nBarcha postlar (yangi mahsulot, chegirma, qayta keldi, random, SKU bo'yicha) 2-kanalga ham ustama narx bilan chiqadi. " +
        "1-kanal va istoriyalarda BITO narxi qoladi; BITO'ga hech narsa yozilmaydi." +
        owner,
      reply_markup: { inline_keyboard: [[btn('➕ 2-kanal ulash', 'c2:set')], back] },
    };
  }
  const p = markupOf(s);
  if (confirmDrop) {
    return {
      text: `🗑 <b>${escHtml(ch2Label(c))}</b> 2-kanal sifatida uzilsinmi? Kanalga boshqa post ketmaydi (kanalning o'zi o'chmaydi).`,
      reply_markup: { inline_keyboard: [[btn('✅ Ha, uzish', 'c2:dy'), btn("⬅️ Yo'q", 'c2')]] },
    };
  }
  const q = await ch2QueueLength();
  const k = ch2Contact(s);
  return {
    text:
      `📢 <b>2-kanal</b>: ${escHtml(c.title || c.id)}${c.username ? ` (@${escHtml(c.username)})` : ''} ${on(c.enabled)}\n\n` +
      `📈 Ustama: ${p}% — masalan 12 345 → ${formatPrice(markupPrice(12345, p))} so'm (minglikka yaxlitlanadi)\n` +
      `📞 Telefon: ${escHtml(k.phone)}${k.phoneOwn ? '' : ' (1-kanaldagidek)'}\n` +
      `🛒 Buyurtma tugmasi: ${escHtml(k.url)}${k.urlOwn ? '' : ' (1-kanaldagidek)'}\n` +
      `Bugun 2-kanalga: ${(await db.getStats()).ch2_posted || 0} ta post` +
      (q ? `\n⏳ Qayta yuborish navbatida: ${q} ta` : '') +
      owner,
    reply_markup: {
      inline_keyboard: [
        [btn(c.enabled ? "✅ Yoqilgan — o'chirish" : '❌ O\'chirilgan — yoqish', 'c2:t')],
        [btn(`📈 Ustama: ${p}%`, 'c2:p')],
        [btn(`📞 Telefon: ${k.phone}${k.phoneOwn ? '' : ' (1-kanal)'}`, 'c2:ph')],
        [btn(`🛒 Buyurtma tugmasi: ${k.url.replace(/^https:\/\//, '')}${k.urlOwn ? '' : ' (1-kanal)'}`.slice(0, 60), 'c2:ou')],
        [btn('🔁 Almashtirish', 'c2:set'), btn('🗑 Uzish', 'c2:d')],
        back,
      ],
    },
  };
}

// ---- "🧰 Qo'shimcha funksiyalar" (owner only): sold mark, price updates, hashtags, logo, "🩺 Holat" ----

const EXTRA_TOGGLES = ['mark_sold', 'price_update', 'hashtags', 'wm_on', 'wm_story', 'health'];

async function extrasView() {
  const s = await db.getSettings();
  const logo = await getLogo().catch(() => null);
  return {
    text:
      "🧰 <b>Qo'shimcha funksiyalar</b>\n\n" +
      '❌ <b>Sotildi belgisi</b> — mahsulot tugasa, kanal postlari boshiga "❌ SOTILDI", tugma olib tashlanadi; qaytsa — asl holiga.\n' +
      "💲 <b>Narx yangilash</b> — narx o'zgarsa, postdagi narx qatori yangilanadi (soatiga 1 marta).\n" +
      '#️⃣ <b>Heshteglar</b> — post oxirida kategoriya heshteglari (istoriyada yo\'q).\n' +
      `🖼 <b>Logo</b> — ${logo ? `o'zingiz yuklagan (${Math.round(logo.length / 1024)} KB)` : 'standart "MIX PODAROK"'}, ${POS_LABEL[positionOf(s)]}, ${opacityOf(s)}% ko'rinadi.\n` +
      '🩺 <b>Kunlik holat</b> — har kuni 08:55 da hisobot va muammo bo\'lsa darhol "⚠️".',
    reply_markup: {
      inline_keyboard: [
        [btn(`❌ Sotildi belgisi: ${on(s.mark_sold !== false)}`, 'xf:t:mark_sold')],
        [btn(`💲 Narx yangilash: ${on(s.price_update !== false)}`, 'xf:t:price_update')],
        [btn(`#️⃣ Heshteglar: ${on(s.hashtags !== false)}`, 'xf:t:hashtags')],
        [btn(`🖼 Logo → kanal: ${on(s.wm_on)}`, 'xf:t:wm_on'), btn(`🖼 Logo → istoriya: ${on(s.wm_story)}`, 'xf:t:wm_story')],
        [btn(`📍 ${POS_LABEL[positionOf(s)]}`, 'xf:pos'), btn(`🌫 Ko'rinish: ${opacityOf(s)}%`, 'xf:op')],
        [btn('🖼 Logo yuklash', 'xf:logo'), ...(logo ? [btn('↩️ Standart logo', 'xf:logod')] : [])],
        [btn('🧪 Logo namunasi', 'xf:wmt')],
        [btn(`🩺 Kunlik holat: ${on(s.health !== false)}`, 'xf:t:health'), btn('🩺 Holat hozir', 'hl')],
        back,
      ],
    },
  };
}

async function handleLogoUpload(msg) {
  const chatId = msg.chat.id;
  if (!isChannel2Owner(msg.from.id)) {
    await db.clearPending(msg.from.id);
    return say(chatId, `🔒 Logoni faqat admin ${channel2Owner()} o'zgartiradi.`);
  }
  const file = msg.document || msg.photo?.[msg.photo.length - 1];
  if (msg.document && !/^image\//.test(msg.document.mime_type || '')) return say(chatId, '❌ Rasm fayl yuboring (PNG).');
  if (file.file_size && file.file_size > LOGO_MAX_BYTES) {
    return say(chatId, `❌ Logo juda katta (${Math.round(file.file_size / 1024)} KB) — ko'pi bilan ${Math.round(LOGO_MAX_BYTES / 1024)} KB. Qayta yuboring:`);
  }
  let bytes;
  try {
    const f = await tg('getFile', { file_id: file.file_id });
    bytes = await downloadImage(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${f.file_path}`);
  } catch (e) {
    return say(chatId, `❌ Faylni yuklab bo'lmadi: ${escHtml(errText(e))}`);
  }
  const bad = await saveLogo(bytes);
  if (bad) return say(chatId, `❌ ${escHtml(bad)} Qayta yuboring:`);
  await db.clearPending(msg.from.id);
  await say(chatId, `✅ Logo saqlandi${msg.photo ? " (rasm sifatida yuborildi — shaffof fon yo'qolgan bo'lishi mumkin; PNG faylni \"fayl\" qilib yuborish yaxshiroq)" : ''}. "🧪 Logo namunasi" bilan ko'ring.`);
  return show(chatId, null, await extrasView());
}

async function extrasCallback(cb, answer, arg, arg2) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  await answer();
  const s = await db.getSettings();
  if (arg === 't' && EXTRA_TOGGLES.includes(arg2)) {
    const cur = ['wm_on', 'wm_story'].includes(arg2) ? Boolean(s[arg2]) : s[arg2] !== false;
    await db.updateSettings({ [arg2]: !cur });
  } else if (arg === 'pos') {
    await db.updateSettings({ wm_pos: POSITIONS[(POSITIONS.indexOf(positionOf(s)) + 1) % POSITIONS.length] });
  } else if (arg === 'op') {
    await db.updateSettings({ wm_opacity: OPACITIES[(OPACITIES.indexOf(opacityOf(s)) + 1) % OPACITIES.length] ?? 50 });
  } else if (arg === 'logo') {
    await db.setPending(cb.from.id, { type: 'wm_logo' });
    return show(chatId, messageId, promptView(`🖼 Logo rasmini yuboring — <b>PNG fayl</b> (shaffof fon saqlanishi uchun "fayl" qilib), ${Math.round(LOGO_MAX_BYTES / 1024)} KB gacha.`));
  } else if (arg === 'logod') {
    await dropLogo();
  } else if (arg === 'wmt') {
    // a sample: the newest product photo (or a plain one) with the mark as it is set now
    let bytes = null;
    try {
      const p = await findLatest();
      if (p) bytes = await downloadImage(toItem(p, 0).image_url);
    } catch {}
    if (!bytes) {
      const sharp = (await import('sharp')).default;
      bytes = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#d9c7a3' } }).jpeg().toBuffer();
    }
    try {
      const jpeg = await applyWatermark(bytes, { ...s, wm_on: true });
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', `🧪 Logo namunasi — ${POS_LABEL[positionOf(s)]}, ${opacityOf(s)}%`);
      form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'sample.jpg');
      await tg('sendPhoto', form);
    } catch (e) {
      await say(chatId, `❌ Namuna chizilmadi: ${escHtml(errText(e))}`);
    }
    return null;
  }
  return show(chatId, messageId, await extrasView());
}

// ---- "👥 Yordamchi adminlar" (owner only): helpers create posts for ONE destination each ----

const pickKey = (uid) => `${db.K.flag('helpers')}:pick:${uid}`;

async function helpersView() {
  const list = await listHelpers();
  const rows = list.map((h) => [btn(`${on(h.active)} ${helperName(h)} → ${h.dest ? h.dest.label : '📍 manzil yo\'q'}`.slice(0, 60), `ha:v:${h.id}`)]);
  return {
    text:
      '👥 <b>Yordamchi adminlar</b>\n\nYordamchi faqat post yaratadi ("📝 Post yaratish": rasm, nom, SKU, narx) va post darhol unga biriktirilgan bitta manzilga ketadi. Admin panel va sozlamalarni ko\'rmaydi. Har joylash sizga nusxa bo\'lib keladi.' +
      (list.length ? '' : "\n\nHali yordamchi yo'q."),
    reply_markup: { inline_keyboard: [...rows, [btn("➕ Qo'shish", 'ha:add')], back] },
  };
}

const FIELD_LABEL = { name: 'Nomi', sku: 'SKU', price: 'Narxi' };
const FIELD_ICON = { name: '🛍', sku: '🔖', price: '💰' };

async function helperView(id, confirmDrop = false) {
  const h = await getHelper(id);
  if (!h) return helpersView();
  if (confirmDrop) {
    return {
      text: `🗑 ${escHtml(helperName(h))} yordamchilar ro'yxatidan o'chirilsinmi?`,
      reply_markup: { inline_keyboard: [[btn("✅ Ha, o'chirish", `ha:dely:${h.id}`), btn("⬅️ Yo'q", `ha:v:${h.id}`)]] },
    };
  }
  return {
    text:
      `👤 <b>${escHtml(helperName(h))}</b> (ID ${escHtml(h.id)}) ${on(h.active)}\n` +
      `📍 Manzil: ${h.dest ? escHtml(h.dest.label) : "tanlanmagan — post joylay olmaydi"}\n` +
      `📝 Joylagan postlari: ${h.posts || 0}\n` +
      `🧩 So'raladi: 📷 rasm${helperFields(h).map((f) => `, ${FIELD_LABEL[f]}`).join('')} (❌ maydon so'ralmaydi va postda chiqmaydi)`,
    reply_markup: {
      inline_keyboard: [
        [btn(`📍 Manzil: ${h.dest ? h.dest.label : 'tanlash'}`.slice(0, 60), `ha:d:${h.id}`)],
        FIELDS.map((f) => btn(`${FIELD_ICON[f]} ${FIELD_LABEL[f]}: ${on(helperFields(h).includes(f))}`, `ha:f:${h.id}:${f}`)),
        [btn(h.active ? "✅ Faol — o'chirish" : '❌ Nofaol — yoqish', `ha:t:${h.id}`), btn('✏️ Ism', `ha:n:${h.id}`)],
        [btn("🗑 O'chirish", `ha:del:${h.id}`)],
        [btn('⬅️ Orqaga', 'ha')],
      ],
    },
  };
}

async function helpersCallback(cb, answer, arg, arg2) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  await answer();
  if (!arg) {
    await db.clearPending(cb.from.id);
    return show(chatId, messageId, await helpersView());
  }
  if (arg === 'add') {
    await db.setPending(cb.from.id, { type: 'helper_add' });
    return show(
      chatId,
      messageId,
      promptView("➕ Yordamchining Telegram ID sini yuboring (ixtiyoriy ism bilan: <code>123456789 Ali</code>) yoki shu odamdan kelgan xabarni forward qiling."),
    );
  }
  const h = await getHelper(arg2);
  if (!h) return show(chatId, messageId, await helpersView());
  if (arg === 'v') return show(chatId, messageId, await helperView(h.id));
  if (arg === 't') {
    await saveHelper({ id: h.id, active: !h.active });
    return show(chatId, messageId, await helperView(h.id));
  }
  if (arg === 'f') {
    // "🛍 Nomi / 🔖 SKU / 💰 Narxi: ✅/❌" — the photo is always asked
    const f = cb.data.split(':')[3];
    if (FIELDS.includes(f)) await saveHelper({ id: h.id, fields: { ...(h.fields || {}), [f]: !helperFields(h).includes(f) } });
    return show(chatId, messageId, await helperView(h.id));
  }
  if (arg === 'n') {
    await db.setPending(cb.from.id, { type: 'helper_name', id: h.id });
    return show(chatId, messageId, promptView(`✏️ ${escHtml(helperName(h))} uchun ism yozing:`));
  }
  if (arg === 'del') return show(chatId, messageId, await helperView(h.id, true));
  if (arg === 'dely') {
    await removeHelper(h.id);
    await say(chatId, `🗑 ${escHtml(helperName(h))} o'chirildi.`);
    return show(chatId, messageId, await helpersView());
  }
  if (arg === 'd') {
    const targets = await dateTargets(await db.getSettings());
    await db.redis().set(pickKey(cb.from.id), { id: h.id, targets }, { ex: 60 * 60 });
    return show(chatId, messageId, {
      text: targets.length
        ? `📍 ${escHtml(helperName(h))} postlari qayerga joylansin? (bittasi)`
        : "❌ Bot admin bo'lgan kanal yoki guruh yo'q. Botni kanal/guruhga admin qilib qo'shing.",
      reply_markup: { inline_keyboard: [...targets.map((x, i) => [btn(x.label, `ha:ds:${h.id}:${i}`)]), [btn('⬅️ Orqaga', `ha:v:${h.id}`)]] },
    });
  }
  if (arg === 'ds') {
    const pick = await db.redis().get(pickKey(cb.from.id));
    const target = pick?.id === h.id ? pick.targets[Number(cb.data.split(':')[3])] : null;
    if (!target) return show(chatId, messageId, await helperView(h.id));
    const bad = await checkTarget(target);
    if (bad) await say(chatId, `⚠️ ${escHtml(bad)} Post joylanmasligi mumkin.`);
    await saveHelper({ id: h.id, dest: target });
    await tg('sendMessage', { chat_id: h.id, text: `📍 Sizning postlaringiz endi shu yerga joylanadi: ${target.label}`, reply_markup: { keyboard: [[{ text: POST_BUTTON }]], resize_keyboard: true, is_persistent: true } }).catch(() => {});
    return show(chatId, messageId, await helperView(h.id));
  }
  return show(chatId, messageId, await helpersView());
}

// ---- "📅 Sana bo'yicha yuborish" (owner only): day -> kind -> ONE destination -> preview -> send ----

const KIND_LABEL = { new: '🆕 Yangi', back: '🔄 Qayta kelgan', both: '🆕+🔄 Ikkalasi' };
const wizKey = (uid) => `${db.K.flag('datesend')}:wiz:${uid}`;
const getWiz = async (uid) => (await db.redis().get(wizKey(uid))) || {};
const setWiz = (uid, w) => db.redis().set(wizKey(uid), w, { ex: 60 * 60 * 2 });

const dsDayView = () => ({
  text: "📅 <b>Sana bo'yicha yuborish</b>\n\nQaysi kunning mahsulotlari? (Toshkent vaqti)",
  reply_markup: { inline_keyboard: [[btn('Bugun', 'ds:d:0'), btn('Kecha', 'ds:d:1')], [btn('✏️ Sana yozish', 'ds:d:ask')], back] },
});

const dsKindView = (w) => ({
  text: `📅 <b>${showDay(w.day)}</b>\n\nQaysi mahsulotlar?\n🆕 Yangi — shu kuni BITO'da yaratilganlar\n🔄 Qayta kelgan — shu kuni ombor skanerida 0 → >0 bo'lganlar`,
  reply_markup: { inline_keyboard: [[btn(KIND_LABEL.new, 'ds:k:new'), btn(KIND_LABEL.back, 'ds:k:back')], [btn(KIND_LABEL.both, 'ds:k:both')], [btn('⬅️ Orqaga', 'ds')]] },
});

async function dsTargetView(w) {
  const rows = w.targets.map((x, i) => [btn(x.label, `ds:t:${i}`)]);
  return {
    text: w.targets.length
      ? `📅 ${showDay(w.day)} · ${KIND_LABEL[w.kind]}\n\nQayerga yuborilsin? (bittasini tanlang)`
      : "❌ Bot admin bo'lgan kanal yoki guruh yo'q. Botni kanal/guruhga admin qilib qo'shing.",
    reply_markup: { inline_keyboard: [...rows, [btn('⬅️ Orqaga', `ds:d:=${w.day}`)]] },
  };
}

async function dsCallback(cb, answer, arg, arg2) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const uid = cb.from.id;
  const s = await db.getSettings();
  await answer();
  if (!arg) {
    await db.clearPending(uid);
    return show(chatId, messageId, dsDayView());
  }
  const w = await getWiz(uid);
  if (arg === 'd') {
    if (arg2 === 'ask') {
      await db.setPending(uid, { type: 'ds_date' });
      return show(chatId, messageId, promptView('✏️ Sanani DD.MM.YYYY ko\'rinishida yozing (masalan 15.10.2026):'));
    }
    const day = arg2?.startsWith('=') ? arg2.slice(1) : daysAgo(Number(arg2) || 0);
    await setWiz(uid, { day });
    return show(chatId, messageId, dsKindView({ day }));
  }
  if (!w.day) return show(chatId, messageId, dsDayView());
  if (arg === 'k') {
    const next = { day: w.day, kind: ['new', 'back', 'both'].includes(arg2) ? arg2 : 'both', targets: await dateTargets(s) };
    await setWiz(uid, next);
    return show(chatId, messageId, await dsTargetView(next));
  }
  if (arg === 't') {
    const target = w.targets?.[Number(arg2)];
    if (!target || !w.kind) return show(chatId, messageId, dsDayView());
    const done = await progress(chatId, `🔎 ${showDay(w.day)} · ${KIND_LABEL[w.kind]} qidirilmoqda...`);
    let found;
    try {
      found = await collectDay(w.day, w.kind, { s });
    } catch (e) {
      return done(`❌ BITO xatosi: ${escHtml(errText(e))}`);
    }
    const next = { ...w, target, ...found };
    await setWiz(uid, next);
    const by = {};
    for (const x of found.skipped) by[x.why] = (by[x.why] || 0) + 1;
    const skippedLine = found.skipped.length ? `\n⏭ O'tkaziladi: ${found.skipped.length} (${Object.entries(by).map(([k, n]) => `${k}: ${n}`).join(', ')})` : '';
    const old = w.kind !== 'new' && Date.now() - Date.parse(`${w.day}T00:00:00+05:00`) > 8 * 86400000 ? "\n⚠️ Qayta kelganlar tarixi 9 kun saqlanadi — bu kun uchun to'liq bo'lmasligi mumkin." : '';
    if (!found.items.length) {
      return done(`📅 ${showDay(w.day)} · ${KIND_LABEL[w.kind]} → ${escHtml(target.label)}\n\nYuboriladigan mahsulot topilmadi.${skippedLine}${old}`);
    }
    const already = await sentAlready(target.id, w.day, found.items);
    const c = found.counts;
    const head =
      `📅 ${showDay(w.day)} → ${escHtml(target.label)}\n` +
      `Topildi: ${found.items.length} ta (yangi ${c.new}, qayta kelgan ${c.back})${skippedLine}` +
      (already.length ? `\n⚠️ ${already.length} tasi bu manzilga allaqachon yuborilgan` : '') +
      old;
    await done(head);
    // the first product exactly as it will look there
    const first = datePost(found.items[0], target, s);
    await tg('sendPhoto', { chat_id: chatId, ...first, caption: `${first.caption}\n\n👆 Namuna (1/${found.items.length})` }).catch((e) =>
      say(chatId, `⚠️ Namuna yuborilmadi: ${escHtml(errText(e))}`),
    );
    return say(chatId, `Har mahsulot alohida post bo'lib, ~3 soniya oraliq bilan yuboriladi.`, {
      reply_markup: { inline_keyboard: [[btn(`✅ Yuborish (${found.items.length})`, 'ds:go'), btn('❌ Bekor', 'ds:x')]] },
    });
  }
  if (arg === 'x') {
    await db.redis().del(wizKey(uid));
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return say(chatId, '❌ Bekor qilindi.');
  }
  if (arg === 'go') {
    if (!w.items?.length || !w.target) return say(chatId, "Tanlov eskirgan — qaytadan boshlang: 📅 Sana bo'yicha yuborish.");
    const running = await getJob();
    if (running) return say(chatId, `⏳ Boshqa yuborish davom etmoqda (${showDay(running.day)} → ${escHtml(running.target.label)}: ${running.sent}/${running.items.length}). Tugagach qayta bosing.`);
    let items = w.items;
    const already = await sentAlready(w.target.id, w.day, items);
    if (already.length && !arg2) {
      const fresh = items.length - already.length;
      return show(chatId, messageId, {
        text: `⚠️ ${already.length} ta mahsulot ${showDay(w.day)} uchun ${escHtml(w.target.label)} ga allaqachon yuborilgan. Yana yuborilsinmi?`,
        reply_markup: {
          inline_keyboard: [
            [btn(`🔁 Ha, hammasini (${items.length})`, 'ds:go:all')],
            ...(fresh ? [[btn(`➡️ Faqat yuborilmaganlarini (${fresh})`, 'ds:go:new')]] : []),
            [btn('❌ Bekor', 'ds:x')],
          ],
        },
      });
    }
    if (arg2 === 'new') {
      const ids = new Set(already.map((i) => String(i.product_id)));
      items = items.filter((i) => !ids.has(String(i.product_id)));
    }
    const bad = await checkTarget(w.target);
    if (bad) return say(chatId, `❌ ${escHtml(bad)}`);
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    const pm = await say(chatId, `📤 ${showDay(w.day)} → ${escHtml(w.target.label)}\nYuborildi 0/${items.length}`);
    await startJob({ chat: chatId, msg: pm?.message_id, day: w.day, kind: w.kind, target: w.target, items, skipped: w.skipped || [] });
    await db.redis().del(wizKey(uid));
    // as much as fits now (the webhook already answered); the tick continues the rest
    return runDateJob(s, { deadline: Date.now() + INTERACTIVE_BUDGET_MS });
  }
  return show(chatId, messageId, dsDayView());
}

const STORY_STATE_TEXT = {
  ok: '',
  off: "o'chirilgan (admin)",
  disabled: "ulanish o'chiq",
  no_rights: "story ruxsati yo'q",
};

// "📸 Istoriya profillari": every stored connection, why it does (not) get stories, today's count.
async function bizView() {
  const [s, biz, st, last, queue] = await Promise.all([db.getSettings(), db.listBiz(), db.getStats(), db.getStoryLast(), db.readStoryQueue()]);
  const lines = ['📸 <b>Istoriya profillari</b>', ''];
  if (!biz.length) {
    lines.push("Biznes ulanish yo'q.", '', 'Telegram → Settings → Telegram Business → Chatbots bo\'limida botni ulang.');
    return { text: lines.join('\n'), reply_markup: { inline_keyboard: [back] } };
  }
  const rows = [];
  for (const b of biz) {
    const state = db.storyState(s, b);
    const mark = state === 'ok' ? '✅' : state === 'off' ? '❌' : '⚪️';
    const waiting = queue.filter((e) => !e.bc || e.bc === b.id).length;
    lines.push(
      `${mark} ${escHtml(db.bizLabel(b))} — ${state === 'ok' ? `bugun ${st[`stories:${b.id}`] || 0}/${db.storyDailyLimit(s)}` : STORY_STATE_TEXT[state]}` +
        (waiting ? `, navbatda ${waiting}` : ''),
    );
    const l = last[b.id];
    // The last Telegram answer for this profile: what actually happened to its stories.
    if (l) lines.push(`   oxirgi: ${fmtDateTime(l.at)} SKU ${escHtml(l.sku)} ${l.ok ? '✅' : `${l.queued ? '⏳' : '❌'} ${escHtml(String(l.error || '')).slice(0, 160)}`}`);
    rows.push([btn(`${mark} ${db.bizLabel(b)}`, `bz:${b.id}`.slice(0, 64))]);
  }
  lines.push('', "Istoriyalar barcha ✅ profillarga yuboriladi (yangi mahsulot, chegirma, random, qayta keldi, qo'lda). Bosib yoqing / o'chiring. Kunlik limit har profil uchun alohida.");
  rows.push([btn('🧪 Test istoriya', 'bzt')]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [...rows, back] } };
}

const LIMIT_LABELS = {
  story_limit: '📱 Story kunlik limiti',
  discount_story_limit: '🔥 Chegirma story kunlik limiti',
  random_album_size: '🎲 Kunlik randomdagi mahsulotlar',
  tick_max_posts: "📤 Bir tick'da max post",
  random_repeat_days: '🔁 Random takrorlanmaslik (kun)',
  low_stock_threshold: '⚠️ "Kam qoldi" chegarasi (dona)',
  restock_days: '🔄 Qayta keldi: takrorlanmaslik (kun)',
  restock_per_tick: "🔄 Qayta keldi: bir tick'da max",
  restock_min_stock: '🔄 Qayta keldi: kamida qoldiq (dona)',
  unsold_days: '📉 Sotilmayotgan: necha kun sotilmagan',
  reorder_days: "🛒 Buyurtma qilish: qoldiq necha kunga yetsa",
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
  photo: "📷 Rasm bo'yicha qidirish",
};

// Bump when the buttons change: every admin gets the new keyboard on the next "⚙️ Admin panel" / /admin.
const KEYBOARD_V = 2;

export const ADMIN_KEYBOARD = {
  keyboard: [
    [{ text: ADMIN_BUTTONS.panel }, { text: ADMIN_BUTTONS.random }],
    [{ text: ADMIN_BUTTONS.report }, { text: ADMIN_BUTTONS.now }],
    [{ text: ADMIN_BUTTONS.photo }],
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

// ---- "📦 Ombor guruhi" ----

// "📦 Ombor guruhi" → which group gets which stock messages.
const ROUTE_LABELS = {
  out: '❌ Tugadi xabarlari',
  back: '✅ Qayta keldi xabarlari',
  report: '📋 Tugaganlar hisoboti',
};
const ROUTE_TEST = {
  out: '✅ Bu guruhga endi "❌ TUGADI" xabarlari keladi.',
  back: '✅ Bu guruhga endi "✅ QAYTA KELDI" xabarlari keladi.',
  report: "✅ Bu guruhga endi tugaganlar hisoboti (kunlik ro'yxat) keladi.",
};

const groupTitle = (groups, id) => groups.find((g) => String(g.id) === String(id))?.title || id;

async function routeView(kind) {
  const [s, groups] = await Promise.all([db.getSettings(), db.listGroups()]);
  const own = s[STOCK_ROUTES[kind]];
  const rows = groups
    .filter((g) => !['left', 'kicked'].includes(g.status))
    .map((g) => [btn(`${own && String(own) === String(g.id) ? '🔘' : '⚪️'} ${g.title}`, `sg:rs:${kind}:${g.id}`)]);
  rows.unshift([btn(`${own ? '⚪️' : '🔘'} Asosiy ombor guruhi${s.stock_group ? ` (${groupTitle(groups, s.stock_group)})` : ''}`, `sg:rs:${kind}:main`)]);
  rows.push([btn('⬅️ Orqaga', 'sg')]);
  return {
    text: `${ROUTE_LABELS[kind]} qaysi guruhga borsin?

Ro'yxatda bot qo'shilgan guruhlar. Yangi guruh kerak bo'lsa, avval botni o'sha guruhga qo'shing (xabar yozishi uchun).`,
    reply_markup: { inline_keyboard: rows },
  };
}

const STOCK_TOGGLES = {
  stock_alerts: '🔔 Darhol xabar (tugadi / qayta keldi)',
  stock_commands: '💬 Guruh buyruqlari',
  stock_daily: '📋 Kunlik ro\'yxat',
};

async function stockView() {
  const [s, groups] = await Promise.all([db.getSettings(), db.listGroups()]);
  const current = groups.find((g) => String(g.id) === String(s.stock_group));
  const lines = ['📦 <b>Ombor guruhi</b>', ''];
  if (!s.stock_group) {
    lines.push(groups.length ? 'Guruhni ro\'yxatdan tanlang:' : "Bot hali hech qanday guruhga qo'shilmagan. Botni guruhga qo'shing — u shu yerda paydo bo'ladi.");
  } else {
    const [out, low] = await Promise.all([outRecords(), lowRecords(s)]);
    const scan = await getScan();
    lines.push(`Guruh: <b>${escHtml(current?.title || s.stock_group)}</b>`);
    lines.push(`❌ Tugagan: ${out.length} ta, ⚠️ kam qolgan: ${low.length} ta (chegara ${db.limit(s, 'low_stock_threshold')} dona)`);
    lines.push(
      `🔄 Katalog: ${scan.last_full_at ? `oxirgi to'liq tekshiruv ${fmtDateTime(scan.last_full_at)}` : "hali to'liq tekshirilmagan"}` +
        (scan.page && !scan.done ? ` · hozirgi o'tish ${scan.seen || 0}/${scan.total || '?'}` : ''),
    );
    if (current && current.can_read === false) {
      lines.push('', "⚠️ Bot guruhda admin emas va privacy mode yoqilgan: pastdagi tugmalar ishlashi uchun botni guruhda <b>admin</b> qiling (yoki @BotFather → /setprivacy → Disable). Buyruqlar (/tugagan, /kam, /bugun, /sku) va \"🔎 SKU qidirish\" baribir ishlaydi.");
    }
    if (current && ['left', 'kicked'].includes(current.status)) {
      lines.push('', '⚠️ Bot bu guruhdan chiqarilgan.');
    }
  }
  const rows = groups
    .filter((g) => !['left', 'kicked'].includes(g.status))
    .map((g) => [btn(`${String(g.id) === String(s.stock_group) ? '🔘' : '⚪️'} ${g.title}`, `sg:sel:${g.id}`)]);
  if (s.stock_group) {
    rows.push(...Object.entries(STOCK_TOGGLES).map(([f, label]) => [btn(`${label}: ${on(s[f])}`, `sg:t:${f}`)]));
    for (const kind of Object.keys(STOCK_ROUTES)) {
      rows.push([btn(`${ROUTE_LABELS[kind]} → ${groupTitle(groups, routeGroup(s, kind))}`, `sg:r:${kind}`)]);
    }
    rows.push([btn(`🕘 Kunlik ro'yxat vaqti: ${s.stock_daily_time}`, 'sg:time')]);
    rows.push([btn(`⚠️ "Kam qoldi" chegarasi: ${db.limit(s, 'low_stock_threshold')} dona`, 'lm:low_stock_threshold')]);
    rows.push([btn("🔄 Katalogni hozir to'liq tekshirish", 'sg:scan')]);
    rows.push([btn("📤 Hisobotni hozir yuborish", 'sg:rep')]);
  }
  rows.push(back);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
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

const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Admin previews: the channel caption, plus the "📢 2-kanal" price when that channel is on.
const previewCaption = (item, s) => {
  const line = ch2PriceLine(item, s);
  return `${buildPostCaption(item, s.phone, { lowAt: db.limit(s, 'low_stock_threshold'), desc: s.ai_channel !== false })}${line ? `\n\n${line}` : ''}`;
};

// For long actions: sends "⏳ ..." immediately and returns done(text) that replaces it with the result.
// After 15 s without a result the message says that the bot is waiting for BITO.
async function progress(chatId, text) {
  const m = await say(chatId, text).catch(() => null);
  let finished = false;
  const slow = setTimeout(() => {
    if (!finished && m?.message_id) {
      tg('editMessageText', {
        chat_id: chatId,
        message_id: m.message_id,
        text: `${text}\n⏳ BITO javobini kutyapman...`,
        parse_mode: 'HTML',
      }).catch(() => {});
    }
  }, progressConfig.slowAfterMs);
  return async (result, extra = {}) => {
    finished = true;
    clearTimeout(slow);
    if (m?.message_id) {
      try {
        return await tg('editMessageText', { chat_id: chatId, message_id: m.message_id, text: result, parse_mode: 'HTML', ...extra });
      } catch (e) {
        if (/not modified/i.test(e.message)) return null;
      }
    }
    return say(chatId, result, extra);
  };
}

const hhmm = (ms) =>
  ms ? new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }) : "hali bo'lmagan";

// ---- manual posting: SKU list or random selection ----

const newSelectionId = () => Math.random().toString(36).slice(2, 10);

// Looks up SKUs in BITO. Imageless/priceless products are left out with a warning; the duplicate check
// is skipped on purpose (the admin asked for these products).
async function loadSkuItems(skus) {
  // All SKUs are looked up in parallel (product + price + "already sent"), results kept in input order.
  const rows = await mapLimit(skus, 6, async (sku) => {
    const p = await findBySku(sku);
    if (!p) {
      return { notes: [`❌ ${sku}: BITO'da topilmadi`] };
    }
    if (!productImage(p)) {
      return { notes: [`⚠️ ${sku}: rasm yo'q — joylanmaydi`] };
    }
    const [pr, sent] = await Promise.all([priceFor(p), db.getSent(sku)]);
    if (!(pr.price > 0)) {
      return { notes: [`⚠️ ${sku}: narx yo'q — joylanmaydi`] };
    }
    const notes = [];
    if (productStock(p) <= 0) notes.push(`⚠️ ${sku}: qoldiq 0`);
    if (sent) notes.push(`ℹ️ ${sku}: avval yuborilgan (${sent.date})`);
    return { item: toItem(p, pr), notes };
  });
  return { items: rows.map((r) => r.item).filter(Boolean), notes: rows.flatMap((r) => r.notes) };
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
    'Kanalga: har mahsulot alohida post\n\n' +
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
      caption: previewCaption(item, s),
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
        media: { type: 'photo', media: item.image_url, caption: previewCaption(item, s), parse_mode: 'HTML' },
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

// Preview: SKU selections as they will look (one post per product); random selections as one post per
// product with its own buttons. Then one control message with the action buttons.
async function showSelection(chatId, { items, notes = [], kind, n }) {
  if (!items.length) {
    return say(chatId, ["❌ Joylash uchun mos mahsulot topilmadi.", ...notes].join('\n'));
  }
  // the preview shows the same "📝" AI description the post will have
  await withDescriptions(items, await db.getSettings(), { deadline: Date.now() + 90000 });
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
      caption: `${previewCaption(items[0], s)}\n\n${text}`,
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }
  // one post per product, as in the channel (no albums)
  for (const i of items) {
    await tg('sendPhoto', { chat_id: chatId, photo: i.image_url, caption: previewCaption(i, s), parse_mode: 'HTML', reply_markup: orderKb(s, i) });
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
    await clearButtons();
    if (isRandom) await closeRandomPreviews(sel);
    await db.deleteSelection(id);
    return say(chatId, '❌ Bekor qilindi.');
  }
  if (action === 'r') {
    await clearButtons();
    await db.deleteSelection(id);
    const done = await progress(chatId, '🎲 Boshqa mahsulotlar tanlanmoqda...');
    if (isRandom) await closeRandomPreviews(sel, { remove: true });
    const next = await pickRandomProducts(sel.n, {
      repeatDays: db.limit(s, 'random_repeat_days'),
      exclude: (isRandom ? sel.slots.map((x) => x.item) : items).map((i) => i.sku),
    });
    if (!next.length) {
      return done('❌ Boshqa mos mahsulot topilmadi.');
    }
    await done(`🎲 ${next.length} ta mahsulot tanlandi 👇`);
    return showSelection(chatId, { items: next, kind: 'random', n: sel.n });
  }
  if (!items.length) {
    return answer("Tanlov bo'sh — avval mahsulot tanlang.", true);
  }
  if (action === 't') {
    const done = await progress(chatId, '🧪 Test yuborilmoqda...');
    const r = await postItemsTest(items, s, chatId);
    const t2 = r.ch2 ? `\n🧪 2-kanal ko'rinishi (+${r.ch2.target.markup}%): ${r.ch2.posted}/${items.length}${errorsText(r.ch2.errors)}` : '';
    return done(`🧪 Test: ${r.posted}/${items.length} ta faqat sizga yuborildi.${errorsText(r.errors)}${t2}`);
  }
  if (!(await db.once(`sel:${id}`, 60 * 60 * 6))) {
    return answer('Allaqachon bajarilgan', true);
  }
  await clearButtons();
  const done = await progress(chatId, `⏳ ${items.length} ta mahsulot joylanmoqda...`);
  if (isRandom) await closeRandomPreviews(sel);
  const lines = [];
  if (action === 'c' || action === 'b') {
    const r = await postItemsNow(items, s, { manual: true });
    lines.push(
      r.channels
        ? `📢 Kanal: ${r.posted.length}/${items.length} ta mahsulot ${r.channels} ta kanalga joylandi.${errorsText(r.errors)}`
        : r.ch2?.target
          ? "📢 1-kanal: faol kanal yo'q."
          : "❌ Faol kanal yo'q.",
    );
    if (r.ch2?.target) lines.push(ch2ReportLine(r.ch2, items.length));
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
  return done(lines.join('\n'));
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

// "🛒 Buyurtmalar": orders in the bot, where they go, BITO sale orders (test mode).
async function ordersView() {
  const [s, groups, st] = await Promise.all([db.getSettings(), db.listGroups(), db.getStats()]);
  const orders = (await db.redis().hgetall(db.K.orders)) || {};
  const open = Object.entries(orders).filter(([k, o]) => k !== 'seq' && o?.status === 'new').length;
  const lines = [
    '🛒 <b>Buyurtmalar</b>',
    '',
    s.order_in_bot !== false
      ? `"🛒 Buyurtma berish" tugmasi botni ochadi: bot sonini, telefonni va manzilni so'raydi, buyurtma ${s.order_group ? `«${escHtml(groupTitle(groups, s.order_group))}» guruhiga` : 'adminlarga'} keladi.${s.bot_username ? '' : '\n⚠️ Bot username hali aniqlanmagan — keyingi tekshiruvda aniqlanadi.'}`
      : `"🛒 Buyurtma berish" tugmasi menejer havolasini ochadi: ${escHtml(s.order_url)}`,
    `Bugun: ${st.orders || 0} ta buyurtma; javob kutayotganlar: ${open} ta`,
  ];
  const rows = [
    [btn(`🛒 Buyurtma bot ichida: ${on(s.order_in_bot !== false)}`, 'ordt:bot')],
    [btn(`📥 Buyurtmalar → ${s.order_group ? groupTitle(groups, s.order_group) : 'adminlarga'}`, 'ordg')],
    [btn(`🧾 BITO'da ham yaratish (sinov): ${on(s.order_bito)}`, 'ordt:bito')],
    back,
  ];
  if (s.order_bito) lines.push('', "🧾 BITO'da yaratish sinov rejimida: Vercel'da BITO_RESPONSIBLE_ID (mas'ul xodim ID) kerak. Natija har buyurtma xabarida yoziladi.");
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// "📊 Savdo tahlili": slow movers, what to order, the weekly report.
async function salesView() {
  const s = await db.getSettings();
  const lines = [
    '📊 <b>Savdo tahlili</b> (BITO sotuv hisoboti)',
    '',
    `📉 Sotilmayotganlar — sotuvda bor, lekin ${db.limit(s, 'unsold_days')} kunda sotilmagan; chegirma e'lon qilish mumkin.`,
    `🛒 Buyurtma qilish kerak — oxirgi 14 kun sotuviga ko'ra qoldig'i ${db.limit(s, 'reorder_days')} kundan kamga yetadi.`,
    "📈 Haftalik hisobot — eng ko'p sotilganlar, tugagan / qayta kelganlar, AI xulosasi (dushanba kunlari).",
  ];
  const rows = [
    [btn('📉 Sotilmayotganlar', 'sav:slow'), btn('🛒 Buyurtma qilish kerak', 'sav:re')],
    [btn('📈 Haftalik hisobot (hozir)', 'sav:week')],
    [btn(`📈 Har dushanba avtomatik: ${on(s.weekly_report !== false)}`, 'sav:t:weekly_report')],
    [btn(`🛒 Har kuni ro'yxat bilan: ${on(s.reorder_daily !== false)}`, 'sav:t:reorder_daily')],
    [btn(`📉 Necha kun: ${db.limit(s, 'unsold_days')}`, 'lm:unsold_days'), btn(`🛒 Necha kunga: ${db.limit(s, 'reorder_days')}`, 'lm:reorder_days')],
    back,
  ];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

const chunkLines = (lines, limit = 3800) => {
  const out = [];
  let cur = '';
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > limit) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) out.push(cur);
  return out;
};

// "🤖 AI tavsif": on / off, and where the "📝" description is shown (channel, groups, stories).
async function aiView() {
  const s = await db.getSettings();
  const key = aiConfigured();
  const lines = [
    '🤖 <b>AI tavsif</b> (Google Gemini)',
    '',
    key ? `Model: ${escHtml(await aiModel())}` : "⚠️ GEMINI_API_KEY yo'q — Vercel → Settings → Environment Variables ga qo'shing va qayta deploy qiling.",
    "Har mahsulot uchun tavsif bir marta yoziladi va saqlanadi. /tavsif SKU — ko'rish, qayta yozdirish yoki o'zingiz yozish.",
  ];
  // Today's numbers and the last attempt: shows at once why posts have no "📝".
  if (key) {
    const [st, last] = await Promise.all([db.getStats(), db.redis().get(db.K.aiLast).catch(() => null)]);
    const n = (k) => st[k] || 0;
    const waitingPosts = Number(await db.redis().llen(db.K.aiBackfill).catch(() => 0)) || 0;
    lines.push('', `📊 Bugun: ${n('ai_desc')} ta yozildi, ${n('ai_failed')} ta xato, ${n('ai_skipped')} ta o'tkazildi (vaqt yetmadi / yaqinda xato)`);
    lines.push(`✏️ Keyin qo'shildi: ${n('ai_backfilled')} ta post; tavsif kutayotgan postlar: ${waitingPosts}`);
    if (last) lines.push(`🕘 Oxirgi: ${fmtDateTime(last.at)} SKU ${escHtml(last.sku)} ${last.ok ? `✅ ${escHtml(last.text)}` : `❌ ${escHtml(last.error)}`}`);
  }
  // Which Vercel project / deployment answers the bot: the key must be in THAT project's variables.
  const where = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (where) lines.push('', `🔧 Bot ishlayotgan Vercel: ${escHtml(where)}${process.env.VERCEL_ENV ? ` (${escHtml(process.env.VERCEL_ENV)})` : ''}`);
  const rows = [
    [btn(`🤖 AI tavsif: ${key ? on(s.ai_desc) : '❌'}`, 'aiv:all')],
    [btn(`📢 Kanalga: ${on(s.ai_channel !== false)}`, 'aiv:ch'), btn(`👥 Guruhga: ${on(s.ai_group !== false)}`, 'aiv:gr')],
    [btn(`📱 Istoriyaga: ${on(s.ai_story !== false)}`, 'aiv:st')],
    [btn(`📷 Rasm bo'yicha qidiruv: ${on(s.photo_search !== false)}`, 'aiv:ps')],
    [btn('🧪 AI sinash', 'ait')],
    back,
  ];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// /tavsif SKU: the product's "📝" description and buttons to rewrite it (AI), write it yourself or delete it.
async function showDesc(chatId, sku, { rewrite = false } = {}) {
  const s = await db.getSettings();
  const p = await findBySku(String(sku), { fresh: true });
  if (!p) return say(chatId, `❌ SKU ${escHtml(sku)} topilmadi.`);
  const item = toItem(p, await priceFor(p, await loadDiscounts()));
  let note = '';
  if (rewrite) {
    if (!aiConfigured()) note = "\n⚠️ GEMINI_API_KEY yo'q — AI yoza olmaydi.";
    else {
      const done = await progress(chatId, '🤖 AI yozmoqda...');
      try {
        await describe(item, s, { force: true });
        await done('✅ Yangi tavsif yozildi.');
      } catch (e) {
        await done(`❌ Gemini xatosi: ${escHtml(errText(e))}`);
      }
    }
  }
  const d = await getDesc(item);
  if (d?.text) item.desc = d.text;
  const caption =
    `${buildPostCaption(item, s.phone, { lowAt: db.limit(s, 'low_stock_threshold') })}\n\n` +
    (d?.text ? `ℹ️ Tavsif: ${d.by === 'admin' ? "o'zingiz yozgan" : 'AI yozgan'}` : "ℹ️ Tavsif hali yo'q — keyingi postda AI yozadi (yoki 🔄 bosing).") +
    note;
  const kb = {
    inline_keyboard: [
      [btn('🔄 AI qayta yozsin', `aid:r:${sku}`), btn("✏️ O'zim yozaman", `aid:e:${sku}`)],
      [btn("🗑 O'chirish", `aid:d:${sku}`)],
    ],
  };
  if (item.image_url) {
    return tg('sendPhoto', { chat_id: chatId, photo: item.image_url, caption, parse_mode: 'HTML', reply_markup: kb }).catch(() =>
      tg('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: kb }),
    );
  }
  return tg('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: kb });
}

async function handlePending(msg, pending) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (pending.type === 'phone') {
    const phone = text.replace(/[\s()-]/g, '');
    if (!PHONE_RE.test(phone)) {
      return say(chatId, "❌ Noto'g'ri raqam. Masalan: +998901234567");
    }
    await db.updateSettings({ phone: phone.startsWith('+') ? phone : `+${phone}` });
  } else if (pending.type === 'ai_desc') {
    if (text.length < 5) return say(chatId, '❌ Juda qisqa. Tavsifni yozing (1-2 gap):');
    await setDesc({ sku: pending.sku, product_id: pending.product_id }, text, 'admin');
    await db.clearPending(msg.from.id);
    return showDesc(chatId, pending.sku);
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
    return show(chatId, null, pending.field === 'low_stock_threshold' ? await stockView() : await limitsView());
  } else if (pending.type === 'stock_time') {
    const m = text.match(/^(\d{1,2})[:.](\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      return say(chatId, "❌ Vaqtni HH:MM ko'rinishida yuboring (masalan 09:00). Qayta yuboring:");
    }
    await db.updateSettings({ stock_daily_time: `${m[1].padStart(2, '0')}:${m[2]}` });
    await db.clearPending(msg.from.id);
    await say(chatId, '✅ Saqlandi.');
    return show(chatId, null, await stockView());
  } else if (pending.type === 'random_n') {
    const n = Number(text);
    if (!/^\d+$/.test(text) || n < 1 || n > RANDOM_MAX) {
      return say(chatId, `❌ 1 dan ${RANDOM_MAX} gacha son yuboring. Qayta yuboring:`);
    }
    await db.clearPending(msg.from.id);
    const done = await progress(chatId, `🎲 ${n} ta tasodifiy mahsulot tanlanmoqda...`);
    try {
      const s = await db.getSettings();
      const items = await pickRandomProducts(n, { repeatDays: db.limit(s, 'random_repeat_days') });
      if (!items.length) {
        return done("❌ Mos mahsulot topilmadi (rasm, narx va qoldiq bo'lishi kerak).");
      }
      await done(`🎲 ${items.length} ta mahsulot tanlandi 👇`);
      return showSelection(chatId, { items, kind: 'random', n });
    } catch (e) {
      console.error('random pick failed:', e);
      return done(`❌ Xato: ${escHtml(errText(e))}`);
    }
  } else if (pending.type === 'wm_logo') {
    return say(chatId, '🖼 Logo rasmini PNG fayl qilib yuboring (yoki ❌ Bekor qilish).');
  } else if (pending.type === 'helper_add' || pending.type === 'helper_name') {
    if (!isChannel2Owner(msg.from.id)) {
      await db.clearPending(msg.from.id);
      return say(chatId, `🔒 Yordamchi adminlarni faqat admin ${channel2Owner()} boshqaradi.`);
    }
    if (pending.type === 'helper_name') {
      const name = text.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name) return say(chatId, '❌ Ismni yozing:');
      await saveHelper({ id: pending.id, name });
      await db.clearPending(msg.from.id);
      return show(chatId, null, await helperView(pending.id));
    }
    const r = parseHelperRef(msg);
    if (r.error) return say(chatId, `❌ ${escHtml(r.error)}`);
    if (isAdmin(r.id)) return say(chatId, "❌ Bu odam allaqachon admin — unga yordamchi kerak emas. Boshqa ID yuboring:");
    const prev = await getHelper(r.id);
    await saveHelper({ id: r.id, name: r.name || prev?.name || '' });
    await db.clearPending(msg.from.id);
    await say(chatId, `✅ Yordamchi qo'shildi: ${escHtml(r.name || r.id)}\nEndi "📍 Manzil" ni tanlang. U botga /start bosishi kerak (bot birinchi bo'lib yoza olmaydi).`);
    return show(chatId, null, await helperView(r.id));
  } else if (pending.type === 'ds_date') {
    if (!isChannel2Owner(msg.from.id)) {
      await db.clearPending(msg.from.id);
      return say(chatId, `🔒 Sana bo'yicha yuborish faqat admin ${channel2Owner()} uchun.`);
    }
    const day = parseDay(text);
    if (!day) return say(chatId, "❌ Sanani DD.MM.YYYY ko'rinishida yozing (masalan 15.10.2026), kelajak sana bo'lmasin. Qayta yuboring:");
    await db.clearPending(msg.from.id);
    await setWiz(msg.from.id, { day });
    return show(chatId, null, dsKindView({ day }));
  } else if (['channel2', 'ch2_markup', 'ch2_phone', 'ch2_order'].includes(pending.type)) {
    if (!isChannel2Owner(msg.from.id)) {
      await db.clearPending(msg.from.id);
      return say(chatId, `🔒 2-kanalni faqat admin ${channel2Owner()} o'zgartira oladi.`);
    }
    const s = await db.getSettings();
    if ((pending.type === 'ch2_phone' || pending.type === 'ch2_order') && !s.channel2?.id) {
      await db.clearPending(msg.from.id);
      return show(chatId, null, await channel2View());
    }
    if (pending.type === 'ch2_phone') {
      const phone = normPhone2(text);
      if (!phone) return say(chatId, "❌ Raqam +998XXXXXXXXX ko'rinishida bo'lishi kerak (masalan +998901234567). Qayta yuboring:");
      await db.updateSettings({ channel2: { ...s.channel2, phone } });
    } else if (pending.type === 'ch2_order') {
      const r = normOrderTarget(text);
      if (r.error) return say(chatId, `❌ ${escHtml(r.error)} Qayta yuboring:`);
      await db.updateSettings({ channel2: { ...s.channel2, order_url: r.url } });
    } else if (pending.type === 'ch2_markup') {
      const value = Number(text);
      if (!/^\d+$/.test(text) || value < MARKUP_MIN || value > MARKUP_MAX) {
        return say(chatId, `❌ ${MARKUP_MIN} dan ${MARKUP_MAX} gacha butun son yuboring (masalan 30). Qayta yuboring:`);
      }
      if (!s.channel2?.id) {
        await db.clearPending(msg.from.id);
        return show(chatId, null, await channel2View());
      }
      await db.updateSettings({ channel2: { ...s.channel2, markup_percent: value } });
    } else {
      const done = await progress(chatId, '🔎 Kanal tekshirilmoqda...');
      const r = await checkChannel2(text, { mainIds: s.channels.map((c) => c.id) });
      if (!r.ok) return done(`❌ ${escHtml(r.error)}\n\nQayta yuboring yoki ⬅️ Orqaga.`);
      await db.updateSettings({
        // "🔁 Almashtirish" keeps the markup, phone and order button
        channel2: {
          ...r.chat,
          enabled: true,
          markup_percent: s.channel2?.markup_percent ?? DEFAULT_MARKUP,
          phone: s.channel2?.phone || '',
          order_url: s.channel2?.order_url || '',
        },
      });
      await done(`✅ 2-kanal ulandi: ${escHtml(r.chat.title)}${r.chat.username ? ` (@${escHtml(r.chat.username)})` : ''}`);
    }
    await db.clearPending(msg.from.id);
    await say(chatId, '✅ Saqlandi.');
    return show(chatId, null, await channel2View());
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

// Result text of "🚀 Hozir joylash" — always says what happened.
function nowSummary(t) {
  const d = t.detected;
  const sk = d.skipped;
  const skippedLine = `o'tkazildi: rasmsiz ${sk.noimage}, narxsiz ${sk.noprice}, qoldiq 0 ${sk.nostock}, takror ${sk.dup}`;
  const skippedAny = sk.noimage + sk.noprice + sk.nostock + sk.dup > 0;
  const lines = ['🚀 <b>Hozir joylash</b>', ''];
  if (!d.found) {
    lines.push(`Yangi mahsulot topilmadi (oxirgi tekshiruv: ${hhmm(d.previous_check)})`);
    if (skippedAny) lines.push(skippedLine);
  } else {
    lines.push(`${d.found} ta topildi: ${t.channel.posted} ta kanalga, ${t.stories.new} ta story; ${skippedLine}`);
  }
  if (t.discounts.discount || t.discounts.restock) {
    lines.push(`🔥 Chegirma: ${t.discounts.discount}, ♻️ yana sotuvda: ${t.discounts.restock}`);
  }
  if (t.active_discounts?.announced) {
    lines.push(`🔥 Faol chegirma e'lonlari: ${t.active_discounts.announced} ta (${t.active_discounts.skus.join(', ')})`);
  }
  if (!d.found && (t.channel.posted || t.stories.new || t.stories.discount)) {
    lines.push(`📦 Navbatdan: ${t.channel.posted} ta kanalga, ${t.stories.new + t.stories.discount} ta story`);
  }
  if (t.channel.skus.length) lines.push(`📢 Kanalga joylangan SKU: ${t.channel.skus.join(', ')}`);
  if (t.stories.skus.length) lines.push(`📱 Story SKU: ${t.stories.skus.join(', ')}`);
  for (const e of [...t.channel.errors, ...t.stories.errors].slice(0, 3)) lines.push(`❗ ${escHtml(e)}`);
  lines.push(`📦 Navbatda qoldi: kanal ${t.queue}, story ${t.story_queue}`);
  return lines.join('\n');
}

async function runNow(chatId) {
  const done = await progress(chatId, '🚀 Yangi mahsulotlar tekshirilmoqda...');
  const started = Date.now();
  try {
    const t = await runTick({ budgetMs: INTERACTIVE_BUDGET_MS });
    console.log(`"Hozir joylash" finished in ${Date.now() - started} ms`);
    if (t.skipped) {
      return done("⏳ Hozir boshqa joylash jarayoni ishlayapti (avtomatik tekshiruv). Birozdan keyin qayta bosing.");
    }
    return done(nowSummary(t));
  } catch (e) {
    console.error('"Hozir joylash" failed:', e);
    return done(`❌ Xato: ${escHtml(errText(e))}${e.details ? `\n<code>${escHtml(JSON.stringify(e.details))}</code>` : ''}`);
  }
}

async function runDiscountNow(chatId) {
  const done = await progress(chatId, '🔥 Chegirmalar tekshirilmoqda...');
  try {
    const t = await runDiscountCheck({ budgetMs: INTERACTIVE_BUDGET_MS });
    if (t.skipped) {
      return done("⏳ Hozir boshqa joylash jarayoni ishlayapti. Birozdan keyin qayta bosing.");
    }
    const a = t.active;
    const lines = ['🔥 <b>Chegirmalar tekshiruvi</b>', '', `Faol chegirmalar: ${a.active} ta, tegishli mahsulotlar: ${a.products} ta`];
    if (a.reason) {
      lines.push("⚠️ \"🔥 Chegirma → kanal\" va \"🔥 Chegirma → story\" o'chiq — hech narsa e'lon qilinmadi.");
    } else {
      lines.push(`Yangi e'lon: ${a.announced} ta (kanalga ${a.channel}, story ${a.story}); avval e'lon qilingan: ${a.already} ta`);
      const sk = a.skipped;
      if (sk.noimage + sk.noprice + sk.nostock) {
        lines.push(`O'tkazildi: rasmsiz ${sk.noimage}, narxsiz ${sk.noprice}, qoldiq 0 ${sk.nostock}`);
      }
      if (a.errors) lines.push(`❗ Xato: ${a.errors} ta (batafsil pastda va Vercel logida)`);
      if (a.skus.length) lines.push(`🔖 SKU: ${a.skus.join(', ')}`);
      const details = discountDetailsText(a, escHtml);
      if (details.length) lines.push('', '<b>Har bir chegirma:</b>', ...details);
    }
    if (t.drops.discount || t.drops.restock) {
      lines.push('', `📉 Narx tushgan: ${t.drops.discount}, ♻️ yana sotuvda: ${t.drops.restock}`);
    }
    lines.push('', `✅ Kanalga joylandi: ${t.channel.posted}, 📱 story: ${t.stories.discount + t.stories.new}`);
    for (const e of [...t.channel.errors, ...t.stories.errors].slice(0, 3)) lines.push(`❗ ${escHtml(e)}`);
    lines.push(`📦 Navbatda qoldi: kanal ${t.queue}, story ${t.story_queue}`);
    // Telegram message limit is 4096 characters.
    let text = lines.join('\n');
    if (text.length > 4000) text = `${text.slice(0, text.lastIndexOf('\n', 3950))}\n…`; // cut at a line, tags stay closed
    return done(text);
  } catch (e) {
    console.error('discount check failed:', e);
    return done(`❌ Xato: ${escHtml(errText(e))}`);
  }
}

const randomPrompt = () => promptView(`🎲 Nechta mahsulot? (1-${RANDOM_MAX})`);

async function runShortcut(action, msg, text) {
  const chatId = msg.chat.id;
  if (action === 'panel') {
    // Show the reply keyboard on /start, the first time and once more whenever its buttons change
    // (KEYBOARD_V); afterwards Telegram keeps it.
    if (/^\/start/.test(text) || (await db.once(`kb:v${KEYBOARD_V}:${msg.from.id}`, 60 * 60 * 24 * 365))) {
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
  return runNow(chatId);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    return handleGroupMessage(msg, await db.getSettings());
  }
  if (msg.chat.type !== 'private') {
    return;
  }
  if (!isAdmin(msg.from?.id)) {
    const s = await db.getSettings();
    // "👥 Yordamchi adminlar": an active helper only creates posts ("📝 Post yaratish")
    const helper = await activeHelper(msg.from?.id);
    if (helper && (await handleHelperMessage(msg, helper, s))) return null;
    if (!helper && text === POST_BUTTON && (await getHelper(msg.from?.id))) {
      return tg('sendMessage', { chat_id: chatId, text: "🔒 Post joylash huquqingiz o'chirilgan. Asosiy adminga yozing." });
    }
    // Customers: product search with price and stock, "🔔 Kelganda xabar ber", order button.
    return handleCustomerMessage(msg, s);
  }
  // "🖼 Logo yuklash": the logo file (before the photo search takes the picture)
  if (msg.photo?.length || msg.document) {
    const p = await db.getPending(msg.from.id);
    if (p?.type === 'wm_logo') return handleLogoUpload(msg);
  }
  // a forwarded message while adding a helper ("👥 Yordamchi adminlar → ➕ Qo'shish")
  if (msg.forward_origin || msg.forward_from || msg.forward_sender_name) {
    const p = await db.getPending(msg.from.id);
    if (p?.type === 'helper_add') return handlePending(msg, p);
  }
  // "📷 Rasm bo'yicha qidirish": a photo from an admin -> SKU, price, stock
  if (msg.photo?.length || msg.document?.mime_type?.startsWith('image/')) {
    await db.clearPending(msg.from.id);
    return handlePhotoSearch(msg, await db.getSettings(), 'staff');
  }
  if (text === ADMIN_BUTTONS.photo) {
    return say(chatId, "📷 Mahsulot rasmini yuboring — BITO'dan topib, SKU, narx va qoldig'ini ko'rsataman.");
  }
  const tav = text.match(/^\/tavsif(?:@\w+)?(?:\s+(\S+))?$/);
  if (tav) {
    if (!tav[1]) return say(chatId, '🤖 Masalan: /tavsif 667142 — mahsulotning AI tavsifini ko\'rish, qayta yozdirish yoki o\'zim yozish.');
    return showDesc(chatId, tav[1]);
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
    const done = await progress(chatId, `🔎 SKU ${skus.join(', ')} qidirilmoqda...`);
    try {
      const { items, notes } = await loadSkuItems(skus);
      if (!items.length) {
        return done(["❌ Joylash uchun mos mahsulot topilmadi.", ...notes].join('\n'));
      }
      await done(`🔎 ${items.length} ta mahsulot topildi 👇`);
      return showSelection(chatId, { items, notes, kind: 'sku' });
    } catch (e) {
      console.error('SKU lookup failed:', e);
      return done(`❌ BITO xatosi: ${escHtml(errText(e))}`);
    }
  }
  // a product name: similar products with photo, name, SKU, price, stock
  if (text.length >= 3 && !text.startsWith('/')) return handleNameSearch(msg, await db.getSettings(), text);
  return say(chatId, 'SKU yuboring (masalan 670897 yoki "670899, 670868"), mahsulot nomini yoki rasmini yuboring, yoki pastdagi tugmalardan foydalaning.');
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
  let answered = false;
  // Only the first call answers the callback; a later alert (important text) is sent as a message.
  const answer = async (text, alert = false) => {
    if (answered) {
      if (alert && text) await say(chatId, `⚠️ ${text}`);
      return;
    }
    answered = true;
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  };
  if (data.startsWith('ord:')) {
    // "🛒 Buyurtma": customers' steps and staff accept / cancel (admins or the order group)
    const s = await db.getSettings();
    return handleOrderCallback(cb, s, { isStaff: isAdmin(cb.from.id) || (s.order_group && String(chatId) === String(s.order_group)) });
  }
  if (data.startsWith('kt:')) {
    // "🗂 Katalog" — for everyone
    return handleCatalogCallback(cb, await db.getSettings());
  }
  if (data.startsWith('hp:')) {
    // "📝 Post yaratish" — a helper's own steps (checked inside: an active helper)
    return handleHelperCallback(cb, await db.getSettings());
  }
  if (data.startsWith('w:')) {
    // "🔔 Kelganda xabar ber" — for every user.
    return handleWaitCallback(cb);
  }
  if (data.startsWith('st:')) {
    // Stock group pages ("➡️ Keyingi") — for every group member.
    return handleGroupCallback(cb, await db.getSettings());
  }
  if (!isAdmin(cb.from.id)) {
    return answer("Ruxsat yo'q", true);
  }
  // "📢 2-kanal": only the owner admin changes it (the others may look at it)
  if (data.startsWith('c2:') && !isChannel2Owner(cb.from.id)) {
    return answer(`🔒 2-kanalni faqat admin ${channel2Owner()} o'zgartira oladi.`, true);
  }
  if ((data === 'xf' || data.startsWith('xf:')) && !isChannel2Owner(cb.from.id)) {
    return answer(`🔒 Qo'shimcha funksiyalarni faqat admin ${channel2Owner()} o'zgartiradi.`, true);
  }
  if ((data === 'ha' || data.startsWith('ha:')) && !isChannel2Owner(cb.from.id)) {
    return answer(`🔒 Yordamchi adminlarni faqat admin ${channel2Owner()} boshqaradi.`, true);
  }
  if ((data === 'ds' || data.startsWith('ds:')) && !isChannel2Owner(cb.from.id)) {
    return answer(`🔒 Sana bo'yicha yuborish faqat admin ${channel2Owner()} uchun.`, true);
  }
  // Answer first so the button stops spinning at once; results follow as messages/edits.
  await answer('⏳ Bajarilmoqda...');
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
    case 'ds':
      return dsCallback(cb, answer, arg, arg2);
    case 'ha':
      return helpersCallback(cb, answer, arg, arg2);
    case 'xf':
      return extrasCallback(cb, answer, arg, arg2);
    case 'hl': {
      await answer();
      const s = await db.getSettings();
      return say(chatId, await healthReport(s, { title: '🩺 <b>Holat (hozir)</b>' }), { reply_markup: { inline_keyboard: [[btn('🔄 Yangilash', 'hl')]] } });
    }
    case 'c2': {
      // "📢 2-kanal" (changes: owner only — checked above)
      await answer();
      const s = await db.getSettings();
      const c = s.channel2;
      if (arg === 'set') {
        await db.setPending(cb.from.id, { type: 'channel2' });
        return show(
          chatId,
          messageId,
          promptView(
            `📢 2-kanal @username yoki -100... ID sini yuboring.${c?.id ? `\nHozirgi: ${escHtml(ch2Label(c))}` : ''}\n\nAvval botni kanalga admin qilib qo'shing ("Xabar joylash" huquqi bilan).`,
          ),
        );
      }
      if (!arg) await db.clearPending(cb.from.id);
      if (arg && !c?.id) return show(chatId, messageId, await channel2View());
      if (arg === 't') {
        await db.updateSettings({ channel2: { ...c, enabled: !c.enabled } });
      } else if (arg === 'p') {
        await db.setPending(cb.from.id, { type: 'ch2_markup' });
        return show(chatId, messageId, promptView(`📈 Hozirgi ustama: ${markupOf(s)}%\n\nYangi foizni yuboring (${MARKUP_MIN}–${MARKUP_MAX} butun son, masalan 30):`));
      } else if (arg === 'ph' || arg === 'ou') {
        const k = ch2Contact(s);
        await db.setPending(cb.from.id, { type: arg === 'ph' ? 'ch2_phone' : 'ch2_order' });
        const text =
          arg === 'ph'
            ? `📞 2-kanal telefoni: ${escHtml(k.phone)}${k.phoneOwn ? '' : ' (1-kanaldagidek)'}\n\nYangi raqamni +998XXXXXXXXX ko'rinishida yuboring (masalan +998901234567):`
            : `🛒 2-kanal "Buyurtma berish" tugmasi: ${escHtml(k.url)}${k.urlOwn ? '' : ' (1-kanaldagidek)'}\n\nYangisini yuboring: @username, t.me havola, https:// havola yoki +998XXXXXXXXX raqam (Telegram'da shu raqamli chat ochiladi).`;
        return show(chatId, messageId, {
          text,
          reply_markup: { inline_keyboard: [[btn('↩️ 1-kanaldagidek', arg === 'ph' ? 'c2:phr' : 'c2:our')], [btn('❌ Bekor qilish', 'c2')]] },
        });
      } else if (arg === 'phr' || arg === 'our') {
        await db.clearPending(cb.from.id);
        await db.updateSettings({ channel2: { ...c, [arg === 'phr' ? 'phone' : 'order_url']: '' } });
      } else if (arg === 'd') {
        return show(chatId, messageId, await channel2View(true));
      } else if (arg === 'dy') {
        await db.updateSettings({ channel2: null });
        await say(chatId, `🗑 2-kanal (${escHtml(ch2Label(c))}) uzildi.`);
      }
      return show(chatId, messageId, await channel2View());
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
    case 'ng': {
      // "🆕 Yangi mahsulot → guruh": a group the bot is in, or off
      await answer();
      if (arg) {
        const id = data.split(':').slice(1).join(':');
        await db.updateSettings({ new_group: id === 'off' ? '' : id });
        if (id !== 'off') {
          const r = await tg('sendMessage', { chat_id: id, text: '✅ Bu guruhga endi yangi mahsulotlar (🆕 YANGI MAHSULOT) keladi.' }).catch((e) => ({ error: errText(e) }));
          if (r?.error) await say(chatId, `⚠️ Guruhga yozib bo'lmadi: ${escHtml(r.error)}\nBotni guruhga qo'shing va yozish huquqini bering.`);
        }
        return show(chatId, messageId, await menuView());
      }
      const [s, groups] = await Promise.all([db.getSettings(), db.listGroups()]);
      const rows = groups
        .filter((g) => !['left', 'kicked'].includes(g.status))
        .map((g) => [btn(`${String(s.new_group) === String(g.id) ? '🔘' : '⚪️'} ${g.title}`, `ng:${g.id}`)]);
      rows.unshift([btn(`${s.new_group ? '⚪️' : '🔘'} ❌ Guruhga yubormaslik`, 'ng:off')]);
      rows.push(back);
      return show(chatId, messageId, {
        text:
          "🆕 Yangi mahsulotlar qaysi guruhga ham borsin?\n\nGuruhga hamma yangi mahsulotlar keladi — kanalga chiqmaganlari ham (rasmsiz / narxsiz / qoldig'i 0), sababi bilan. Kanalga yuborish \"🆕 Yangi mahsulot → kanal\" tugmasi bilan alohida boshqariladi.\n\nRo'yxatda bot qo'shilgan guruhlar.",
        reply_markup: { inline_keyboard: rows },
      });
    }
    case 'tnc':
      await toggle('new_channel');
      break;
    case 'tdc':
      await toggle('discount_channel');
      break;
    case 'trp':
      await toggle('restock_post');
      break;
    case 'ai':
      await answer();
      return show(chatId, messageId, await aiView());
    case 'aiv': {
      const field = { all: 'ai_desc', ch: 'ai_channel', gr: 'ai_group', st: 'ai_story', ps: 'photo_search' }[arg];
      if (!field) return null;
      if (!aiConfigured()) return answer("GEMINI_API_KEY yo'q: Vercel → Settings → Environment Variables ga qo'shing va qayta deploy qiling.", true);
      await toggle(field);
      return show(chatId, messageId, await aiView());
    }
    case 'ordv':
    case 'ordt':
    case 'ordg': {
      if (cmd === 'ordt') {
        const field = { bot: 'order_in_bot', bito: 'order_bito' }[arg];
        if (field) await toggle(field);
      }
      if (cmd === 'ordg' && arg) {
        const id = data.split(':').slice(1).join(':');
        await db.updateSettings({ order_group: id === 'admins' ? '' : id });
        if (id !== 'admins') {
          const r = await tg('sendMessage', { chat_id: id, text: '✅ Bu guruhga endi botdagi buyurtmalar (🛒 Yangi buyurtma) keladi.' }).catch((e) => ({ error: errText(e) }));
          if (r?.error) await say(chatId, `⚠️ Guruhga yozib bo'lmadi: ${escHtml(r.error)}`);
        }
      }
      await answer();
      if (cmd === 'ordg' && !arg) {
        const [s, groups] = await Promise.all([db.getSettings(), db.listGroups()]);
        const rows = groups
          .filter((g) => !['left', 'kicked'].includes(g.status))
          .map((g) => [btn(`${String(s.order_group) === String(g.id) ? '🔘' : '⚪️'} ${g.title}`, `ordg:${g.id}`)]);
        rows.unshift([btn(`${s.order_group ? '⚪️' : '🔘'} 👤 Adminlarga (shaxsiy chat)`, 'ordg:admins')]);
        rows.push([btn('⬅️ Orqaga', 'ordv')]);
        return show(chatId, messageId, { text: "🛒 Buyurtmalar qayerga borsin? Guruh ro'yxatida bot qo'shilgan guruhlar.", reply_markup: { inline_keyboard: rows } });
      }
      return show(chatId, messageId, await ordersView());
    }
    case 'sav': {
      await answer();
      const s = await db.getSettings();
      if (arg === 't') {
        const field = data.split(':')[2];
        if (['weekly_report', 'reorder_daily'].includes(field)) await toggle(field);
        return show(chatId, messageId, await salesView());
      }
      if (!arg) return show(chatId, messageId, await salesView());
      const done = await progress(chatId, "📊 BITO sotuv hisoboti o'qilmoqda...");
      try {
        if (arg === 'week') return done(await weeklyReport(s));
        if (arg === 're') {
          const r = await reorderList(s);
          await done(reorderLines(r).slice(0, 2).join('\n') || '🛒');
          for (const part of chunkLines(reorderLines(r).slice(2))) await say(chatId, escHtml(part));
          return null;
        }
        if (arg === 'slow') {
          const r = await slowMovers(s);
          await done(escHtml(slowLines(r)[0]));
          for (const part of chunkLines(slowLines(r).slice(2))) await say(chatId, escHtml(part));
          if (r.list.some((x) => x.sku)) {
            await say(chatId, "🔥 Chegirma e'lon qilish uchun mahsulotni tanlang (avval BITO'da ham chegirma qo'ying — kassada shu narx chiqishi uchun):", {
              reply_markup: { inline_keyboard: r.list.filter((x) => x.sku).slice(0, 10).map((x) => [btn(`🔥 ${x.sku} — ${String(x.name).slice(0, 35)}`, `sl:${x.sku}`)]) },
            });
          }
          return null;
        }
      } catch (e) {
        return done(`❌ ${escHtml(errText(e))}`);
      }
      return null;
    }
    case 'sl': {
      // a discount post for a slow mover: choose the percent -> preview -> post
      await answer();
      const s = await db.getSettings();
      const sku = arg === 'p' || arg === 'go' ? data.split(':')[2] : arg;
      const pct = Number(data.split(':')[3]) || 0;
      const p = await findBySku(String(sku), { fresh: true });
      if (!p) return say(chatId, `❌ SKU ${escHtml(sku)} topilmadi.`);
      const base = toItem(p, await priceFor(p, await loadDiscounts()));
      const listPrice = Number(base.old_price) || Number(base.price);
      if (!(listPrice > 0)) return say(chatId, "❌ Bu mahsulotning narxi yo'q.");
      if (arg !== 'p' && arg !== 'go') {
        return say(chatId, `🔥 SKU ${escHtml(sku)} — ${escHtml(p.name)}\nNarxi: ${formatPrice(listPrice)} so'm. Necha foiz chegirma?`, {
          reply_markup: { inline_keyboard: [[10, 15, 20, 30].map((n) => btn(`-${n}%`, `sl:p:${sku}:${n}`))] },
        });
      }
      const price = Math.floor((listPrice * (100 - pct)) / 100 / 100) * 100 || Math.round((listPrice * (100 - pct)) / 100); // never less of a discount than promised
      const item = { ...base, type: 'discount', old_price: listPrice, price, force: true };
      if (arg === 'p') {
        return say(
          chatId,
          `${previewCaption(item, s)}\n\n⚠️ Kanalga shu narx chiqadi. Kassada ham shu narx bo'lishi uchun <b>BITO'da ham ${pct}% chegirma qo'ying</b>.`,
          { reply_markup: { inline_keyboard: [[btn('✅ Kanalga joylash', `sl:go:${sku}:${pct}`), btn('❌ Bekor', 'sav')]] } },
        );
      }
      const r = await postItemsNow([item], s, { manual: true });
      const l2 = r.ch2?.target ? `\n${ch2ReportLine(r.ch2, 1)}` : '';
      return say(chatId, (r.posted.length ? `✅ Chegirmali post kanalga joylandi (SKU ${escHtml(sku)}, -${pct}%).` : `❌ Joylanmadi: ${escHtml(r.errors.join('; ') || "faol kanal yo'q")}`) + l2);
    }
    case 'psq':
      // also sends the reply keyboard (with the photo button) again
      await answer();
      return say(chatId, "📷 Mahsulot rasmini yuboring — BITO'dan topib, SKU, narx va qoldig'ini ko'rsataman. Nomini yozsangiz ham bo'ladi.");
    case 'tai': {
      if (!aiConfigured()) {
        return answer("GEMINI_API_KEY yo'q: Vercel → Settings → Environment Variables ga qo'shing va qayta deploy qiling.", true);
      }
      await toggle('ai_desc');
      break;
    }
    case 'ait': {
      // "🧪 AI sinash": one description for the newest product with a photo — shows the key works
      if (!aiConfigured()) {
        return answer("GEMINI_API_KEY yo'q: Vercel → Settings → Environment Variables ga qo'shing va qayta deploy qiling.", true);
      }
      const done = await progress(chatId, `🤖 Gemini (${await aiModel()}) sinalmoqda...`);
      try {
        const p = await findLatest();
        if (!p) return done("❌ BITO'da rasmli mahsulot topilmadi.");
        const item = toItem(p, await priceFor(p, await loadDiscounts()));
        const t0 = Date.now();
        const text = await generateDesc(item);
        return done(`✅ Gemini ishlayapti (${await aiModel()}, ${((Date.now() - t0) / 1000).toFixed(1)} s)\n\nSKU ${escHtml(item.sku)} — ${escHtml(item.name)}\n📝 ${escHtml(text)}`);
      } catch (e) {
        return done(`❌ Gemini xatosi: ${escHtml(errText(e))}\n\nKalit to'g'ri qo'yilganini va Vercel'da qayta deploy qilinganini tekshiring.`);
      }
    }
    case 'aid': {
      // /tavsif SKU buttons: r = rewrite, e = write it myself, d = delete
      const sku = arg2;
      const p = await findBySku(String(sku), { fresh: true });
      if (!p) return say(chatId, `❌ SKU ${escHtml(sku)} topilmadi.`);
      const item = toItem(p, 0);
      if (arg === 'e') {
        await db.setPending(cb.from.id, { type: 'ai_desc', sku: String(sku), product_id: String(p._id) });
        return say(chatId, `✏️ SKU ${escHtml(sku)} uchun tavsifni yozing (1-2 gap, 300 belgigacha):`);
      }
      if (arg === 'd') {
        await dropDesc(item);
        return say(chatId, `🗑 SKU ${escHtml(sku)} tavsifi o'chirildi — keyingi postda AI qayta yozadi.`);
      }
      return showDesc(chatId, sku, { rewrite: true });
    }
    case 'trn':
      await toggle('restock_night');
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
        const on_ = (s.story_bcs || {})[id] !== false;
        await db.updateSettings({ story_bcs: { ...(s.story_bcs || {}), [id]: !on_ } });
        const b = biz.find((x) => x.id === id);
        const state = b ? db.storyState({ ...s, story_bcs: { ...(s.story_bcs || {}), [id]: !on_ } }, b) : 'ok';
        await answer(
          on_
            ? "❌ Istoriyalar bu profilga yuborilmaydi"
            : state === 'ok'
              ? '✅ Istoriyalar bu profilga ham yuboriladi'
              : `⚠️ Yoqildi, lekin: ${STORY_STATE_TEXT[state]}`,
        );
      } else {
        await answer();
      }
      return show(chatId, messageId, await bizView());
    }
    case 'bzt': {
      const s = await db.getSettings();
      const profiles = db.storyProfiles(s, await db.listBiz());
      if (arg !== 'y') {
        await answer();
        if (!profiles.length) return show(chatId, messageId, { text: "❌ Istoriya uchun ✅ profil yo'q.", reply_markup: { inline_keyboard: [[btn('⬅️ Orqaga', 'bz')]] } });
        return show(chatId, messageId, {
          text:
            `🧪 <b>Test istoriya</b>\n\nOxirgi rasmli mahsulot "🧪 Test istoriya" belgisi bilan ${profiles.length} ta profilga yuboriladi: ${profiles.map((p) => escHtml(p.label)).join(', ')}.\n` +
            'Istoriya 6 soat turadi va mijozlarga ko\'rinadi. Yuboraymi?',
          reply_markup: { inline_keyboard: [[btn('✅ Ha, yuborish', 'bzt:y'), btn('⬅️ Orqaga', 'bz')]] },
        });
      }
      const done = await progress(chatId, '🧪 Test istoriya yuborilmoqda...');
      try {
        const p = await findLatest();
        if (!p) return done("❌ BITO'da rasmli mahsulot topilmadi.");
        const item = toItem(p, await priceFor(p, await loadDiscounts()));
        const r = await postStoryToAll(item, s, {
          deadline: Date.now() + INTERACTIVE_BUDGET_MS,
          caption: `🧪 <b>Test istoriya</b>\n\n${buildPostCaption(item, s.phone)}`,
          activePeriod: 21600,
          ignoreLimit: true,
          noQueue: true,
          profiles,
        });
        const hints = [...new Set(r.profiles.filter((x) => !x.ok).map((x) => storyErrorHint(x.error)).filter(Boolean))];
        return done([`🧪 Test (SKU ${escHtml(item.sku)})`, storyLine(r), ...hints.map((h) => `💡 ${h}`)].join('\n'));
      } catch (e) {
        return done(`❌ Xato: ${escHtml(errText(e))}`);
      }
    }
    case 'rep':
      await answer();
      return say(chatId, await buildReport());
    case 'now':
      return runNow(chatId);
    case 'dcn':
      return runDiscountNow(chatId);
    case 'sg': {
      if (arg === 'sel') {
        const id = data.split(':').slice(2).join(':');
        await db.updateSettings({ stock_group: id });
        const r = await connectGroup(id).catch((e) => ({ error: errText(e) }));
        if (r.error) await say(chatId, `⚠️ Guruhga yozib bo'lmadi: ${escHtml(r.error)}`);
      } else if (arg === 'r') {
        const kind = data.split(':')[2];
        if (STOCK_ROUTES[kind]) return show(chatId, messageId, await routeView(kind));
      } else if (arg === 'rs') {
        const [, , kind, ...rest] = data.split(':');
        const id = rest.join(':');
        if (STOCK_ROUTES[kind]) {
          await db.updateSettings({ [STOCK_ROUTES[kind]]: id === 'main' ? '' : id });
          const s2 = await db.getSettings();
          const target = routeGroup(s2, kind);
          // A message in the chosen group right away: it shows the bot can write there.
          if (target) {
            const r = await tg('sendMessage', { chat_id: target, text: ROUTE_TEST[kind] }).catch((e) => ({ error: errText(e) }));
            if (r?.error) await say(chatId, `⚠️ Guruhga yozib bo'lmadi: ${escHtml(r.error)}\nBotni guruhga qo'shing va yozish huquqini bering.`);
          }
        }
      } else if (arg === 't') {
        const field = data.split(':')[2];
        if (STOCK_TOGGLES[field]) await toggle(field);
      } else if (arg === 'time') {
        const s = await db.getSettings();
        await db.setPending(cb.from.id, { type: 'stock_time' });
        return show(chatId, messageId, promptView(`🕘 Hozirgi vaqt: ${s.stock_daily_time} (Toshkent)\n\nYangi vaqtni HH:MM ko'rinishida yuboring:`));
      } else if (arg === 'scan') {
        const s = await db.getSettings();
        const done = await progress(chatId, scanProgressText(await getScan()));
        let lastEdit = 0;
        const editProgress = async (st) => {
          if (Date.now() - lastEdit < stockConfig.progressEveryMs) return;
          lastEdit = Date.now();
          await done(scanProgressText(st)).catch(() => {});
        };
        try {
          // A fresh pass from the first page (continues the current one if it is still running).
          const cur = await getScan();
          const r = await scanCatalog(s, { deadline: Date.now() + INTERACTIVE_BUDGET_MS, restart: Boolean(cur.done), onProgress: editProgress });
          if (r.busy) return done(`🔄 Katalog hozir boshqa jarayonda tekshirilmoqda (${r.state.seen || 0}/${r.state.total || '?'}).`);
          const [out, low] = await Promise.all([outRecords(), lowRecords(s)]);
          return done(
            r.state.done
              ? `✅ Tekshiruv tugadi: ${r.state.seen} ta mahsulot tekshirildi.\n❌ Tugagan: ${out.length} ta, ⚠️ Kam qolgan: ${low.length} ta`
              : ['⏳ Vaqt yetmadi — keyingi tekshiruvlarda davom etadi.', ...scanStatusLines(r.state)].join('\n'),
          );
        } catch (e) {
          return done(`❌ Xato: ${escHtml(errText(e))}`);
        }
      } else if (arg === 'rep') {
        const s = await db.getSettings();
        if (!routeGroup(s, 'report')) return say(chatId, '❌ Avval ombor guruhini tanlang.');
        const done = await progress(chatId, '📤 Ombor hisoboti yuborilmoqda...');
        try {
          const r = await sendStockReport(routeGroup(s, 'report'), s, { deadline: Date.now() + INTERACTIVE_BUDGET_MS });
          if (!r.partial) return done(`✅ Guruhga yuborildi: tugagan ${r.out} ta, kam qolgan ${r.low} ta.`);
          const st = await getScan();
          return done(
            st.last_full_at
              ? `✅ Katalog tekshirildi va to'liq hisobot guruhga yuborildi.`
              : ['🔄 Katalog hali to\'liq tekshirilmagan — guruhda tekshiruv davom etmoqda, tugagach to\'liq hisobot yuboriladi.', ...scanStatusLines(st)].join('\n'),
          );
        } catch (e) {
          return done(`❌ Xato: ${escHtml(errText(e))}`);
        }
      }
      return show(chatId, messageId, await stockView());
    }
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
  if (update.my_chat_member) {
    return handleMyChatMember(update.my_chat_member, notifyAdmins);
  }
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
