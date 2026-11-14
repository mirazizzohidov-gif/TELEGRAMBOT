// Privacy policy page (needed by Pinterest / Google / Meta app settings): /api/privacy
const HTML = `<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mixpodarok — Maxfiylik siyosati / Privacy Policy</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#222}h1{font-size:26px}h2{font-size:19px;margin-top:28px}</style></head><body>
<h1>Mixpodarok — Maxfiylik siyosati</h1>
<p>Yangilangan: 2026-yil noyabr. Ushbu siyosat Mixpodarok sovg'a do'koni (mixpodarok.uz) va uning Telegram boti hamda ijtimoiy tarmoqlarga avtomatik joylash vositasi qanday ma'lumotlardan foydalanishini tushuntiradi.</p>
<h2>Qanday ma'lumot ishlatiladi</h2>
<p>Vosita faqat do'konimizning o'z mahsulotlari haqidagi ma'lumotlarni (rasm, nom, narx, mavjudlik) o'z akkauntlarimizga (Telegram, Instagram, Facebook, Threads, YouTube, TikTok, Pinterest) joylash uchun ishlatadi. Ulangan akkauntlarning kirish tokenlari faqat shu maqsadda xavfsiz saqlanadi.</p>
<p>Mijozlar bizga Telegram yoki Instagram orqali yozganda, javob berish va buyurtmani rasmiylashtirish uchun ularning foydalanuvchi nomi, yuborgan xabari va (buyurtma uchun) telefon raqami ishlatiladi.</p>
<h2>Ma'lumotlarni ulashish</h2>
<p>Ma'lumotlar sotilmaydi va uchinchi shaxslarga berilmaydi. Ular faqat tegishli platformalarning rasmiy API'lari orqali o'z akkauntlarimizda kontent joylash va mijozlarga javob berish uchun ishlatiladi.</p>
<h2>Saqlash va o'chirish</h2>
<p>Ma'lumotlar ish uchun kerak bo'lgan muddat davomida saqlanadi. Ma'lumotlaringizni o'chirishni so'rash uchun biz bilan bog'laning — so'rov 30 kun ichida bajariladi.</p>
<h2>Aloqa</h2>
<p>Telegram: @MixPost_robot · Sayt: <a href="https://mixpodarok.uz">mixpodarok.uz</a></p>
<hr>
<h1>Privacy Policy (English)</h1>
<p>This tool is used only by the Mixpodarok gift shop (mixpodarok.uz) to publish its own product information (photo, name, price, availability) to its own accounts on Telegram, Instagram, Facebook, Threads, YouTube, TikTok and Pinterest, and to answer customers who message the shop. Access tokens of the connected accounts are stored securely and used only for this purpose. Customer usernames, messages and (for orders) phone numbers are used only to reply and process orders. No data is sold or shared with third parties. To request deletion of your data, contact us via Telegram @MixPost_robot; requests are handled within 30 days.</p>
</body></html>`;

export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).send(HTML);
}
