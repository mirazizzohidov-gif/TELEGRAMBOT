// «❌ TUGADI» / «⚠️ KAM QOLDI» xabari: har mahsulot alohida rasm + to'liq ma'lumot (chakana, tannarx, BITO kategoriya teglari, bo'lim).
import { formatPrice } from './bito.js';
import { outDateText, priceText } from './stock.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

// "Go'zallik va parfyum" -> #Go_zallik_va_parfyum
export const hashtag = (name) => {
  const t = String(name || '')
    .replace(/['ʻ’`‘]/g, '_')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return t ? `#${t}` : '';
};

// path: ['Go'zallik va parfyum', 'Atirlar va parfyumlar', 'Dubay atiri'] (asosiy → eng pastki)
export function richCaption(r, { head, path = [], low = false } = {}) {
  const tags = [...new Set((path.length ? path : [r.catn]).filter(Boolean).map(hashtag).filter(Boolean))];
  const lines = [head, `🛍 ${r.name}`, `🔢 SKU: ${r.sku}`, `💰 Chakana: ${priceText(r)}`, `🏷 Tannarx: ${r.cost > 0 ? `${formatPrice(r.cost)} so'm` : 'kiritilmagan'}`, `📦 Qoldiq: ${low ? r.stock : 0}`];
  if (tags.length) {
    lines.push('🗂 BITO kategoriya:', tags[0]);
    if (tags.length > 1) lines.push(tags.slice(1).join(' '));
  }
  const root = path[0] || r.catn;
  if (root) lines.push(`📁 Bo'lim: ${root}`);
  if (!low) lines.push(`📅 Tugagan sana: ${outDateText(r)}`);
  return lines.join('\n').slice(0, 1020);
}

// bitta mahsulot — bitta xabar (rasm bo'lsa rasm bilan)
export async function sendProduct(chat, extra, r, caption) {
  if (r.img) {
    try {
      return await tg('sendPhoto', { chat_id: chat, photo: r.img, caption, ...extra });
    } catch (e) {
      if (/retry after|thread not found|TOPIC_|rights|not a forum/i.test(errText(e))) throw e;
    }
  }
  return tg('sendMessage', { chat_id: chat, text: `🖼 (rasm yo'q)\n${caption}`, ...extra });
}
