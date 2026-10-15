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

// HTML caption for a queue item (parse_mode: 'HTML'). Same template, one header per kind so customers
// do not mix them up: back in stock "🔄 Yana sotuvda!" (the struck-through old price stays when
// discounted), discount "🔥 CHEGIRMA!" (old price struck through), a product just added to BITO
// (item.fresh) "🆕 Yangi mahsulot!"; random / manual posts have none.
// opts.lowAt: stock at or below it adds "⏳ Cheklangan miqdorda" (without the number).
export function buildPostCaption(item, phone, { lowAt = 0 } = {}) {
  const discounted = Number(item.old_price) > Number(item.price);
  const header = item.type === 'restock'
    ? '🔄 <b>Yana sotuvda!</b>\n\n'
    : discounted || item.type === 'discount'
      ? '🔥 <b>CHEGIRMA!</b>\n\n'
      : item.fresh
        ? '🆕 <b>Yangi mahsulot!</b>\n\n'
        : '';
  const stock = Number(item.stock);
  const low = lowAt > 0 && stock > 0 && stock <= lowAt ? '⏳ Cheklangan miqdorda\n' : '';
  const price = discounted ? `<s>${formatPrice(item.old_price)}</s> → ${formatPrice(item.price)}` : formatPrice(item.price);
  return (
    header +
    `🛍 Mahsulot nomi: ${esc(item.name)}\n` +
    `💰 Narxi: ${price} so'm\n` +
    low +
    '\n' +
    `📞 Buyurtma uchun murojaat qiling: ${esc(contactPhone(phone))}`
  );
}
