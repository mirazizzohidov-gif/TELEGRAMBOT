import { formatPrice } from './bito.js';

const DEFAULT_CONTACT_PHONE = '+998982000307';

export const contactPhone = (phone) => phone || process.env.CONTACT_PHONE || DEFAULT_CONTACT_PHONE;

// Plain-text caption (used by /api/send and /api/story).
export function buildCaption(name, price, phone) {
  return (
    `🛍 Mahsulot nomi: ${name}\n` +
    `💰 Narxi: ${price} so'm\n\n` +
    `📞 Buyurtma uchun murojaat qiling: ${contactPhone(phone)}`
  );
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// HTML caption for a queue item (parse_mode: 'HTML'). Same template, plus a header for discount/restock.
export function buildPostCaption(item, phone) {
  const header =
    item.type === 'discount' ? '🔥 <b>Chegirma!</b>\n\n' : item.type === 'restock' ? '✅ <b>Yana sotuvda</b>\n\n' : '';
  const price =
    item.type === 'discount' && item.old_price
      ? `<s>${formatPrice(item.old_price)}</s> → <b>${formatPrice(item.price)}</b>`
      : formatPrice(item.price);
  return (
    header +
    `🛍 Mahsulot nomi: ${esc(item.name)}\n` +
    `💰 Narxi: ${price} so'm\n\n` +
    `📞 Buyurtma uchun murojaat qiling: ${esc(contactPhone(phone))}`
  );
}
