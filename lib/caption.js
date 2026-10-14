const DEFAULT_CONTACT_PHONE = '+998982000307';

export function buildCaption(name, price) {
const phone = process.env.CONTACT_PHONE || DEFAULT_CONTACT_PHONE;
return (
`🛍 Mahsulot nomi: ${name}\n` +
`💰 Narxi: ${price} so'm\n\n` +
`📞 Buyurtma uchun murojaat qiling: ${phone}`
);
}
