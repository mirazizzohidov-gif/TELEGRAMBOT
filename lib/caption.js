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

// HTML caption for a queue item (parse_mode: 'HTML'). Same template; a discounted product (old_price
// above price — a BITO discount or a price drop) gets "🔥 CHEGIRMA!" and the old price struck through;
// a product back in stock gets "🔄 YANA SOTUVDA!" (the struck-through price stays when discounted).
export function buildPostCaption(item, phone) {
  const discounted = Number(item.old_price) > Number(item.price);
  const header = item.type === 'restock'
    ? '🔄 <b>YANA SOTUVDA!</b>\n\n'
    : discounted || item.type === 'discount'
      ? '🔥 <b>CHEGIRMA!</b>\n\n'
      : '';
  const price = discounted ? `<s>${formatPrice(item.old_price)}</s> → ${formatPrice(item.price)}` : formatPrice(item.price);
  return (
    header +
    `🛍 Mahsulot nomi: ${esc(item.name)}\n` +
    `💰 Narxi: ${price} so'm\n\n` +
    `📞 Buyurtma uchun murojaat qiling: ${esc(contactPhone(phone))}`
  );
}
