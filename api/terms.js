// Terms of service page (needed by TikTok / Pinterest app settings): /api/terms
const HTML = `<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mixpodarok — Foydalanish shartlari / Terms of Service</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#222}h1{font-size:26px}h2{font-size:19px;margin-top:28px}</style></head><body>
<h1>Mixpodarok — Foydalanish shartlari</h1>
<p>Yangilangan: 2026-yil noyabr.</p>
<p>Ushbu vosita (Mixpodarok Poster) Mixpodarok sovg'a do'koni (mixpodarok.uz) tomonidan faqat o'z ichki ehtiyojlari uchun ishlatiladi: do'konning o'z mahsulotlari haqidagi rasm, video, nom va narxlarni do'konning o'z ijtimoiy tarmoq akkauntlariga avtomatik joylaydi va mijozlarning savollariga javob beradi.</p>
<h2>Foydalanish</h2>
<p>Vositadan faqat Mixpodarok va unga ruxsat berilgan xodimlar foydalanadi. Har bir platformaga (TikTok, Instagram, Facebook, Threads, YouTube, Pinterest, Telegram) joylanadigan kontent o'sha platformaning qoidalariga mos bo'lishi kerak. Kontent uchun javobgarlik Mixpodarok zimmasida.</p>
<h2>Ma'lumotlar</h2>
<p>Ma'lumotlardan foydalanish <a href="/api/privacy">Maxfiylik siyosati</a>da tushuntirilgan.</p>
<h2>O'zgarishlar va aloqa</h2>
<p>Shartlar vaqti-vaqti bilan yangilanishi mumkin. Savollar uchun: Telegram @MixPost_robot, sayt <a href="https://mixpodarok.uz">mixpodarok.uz</a>.</p>
<hr>
<h1>Terms of Service (English)</h1>
<p>Mixpodarok Poster is an internal tool used only by the Mixpodarok gift shop (mixpodarok.uz) to publish its own product content to its own social media accounts and to answer customer questions. Only Mixpodarok and its authorized staff use it. Content must follow each platform's rules; Mixpodarok is responsible for the content it publishes. Data handling is described in our <a href="/api/privacy">Privacy Policy</a>. Contact: Telegram @MixPost_robot.</p>
</body></html>`;

export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).send(HTML);
}
