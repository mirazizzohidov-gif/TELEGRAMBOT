# BITO Telegram bot (Vercel)

Telegram kanalga mahsulot rasmi, nomi va narxini yuboruvchi oddiy Vercel funksiyasi. Mahsulot ma'lumotlari har bir so'rovning JSON body'sida yuboriladi.

## O'rnatish

1. Repo'ni Vercel'ga import qiling.
2. Vercel loyihasida **Settings → Environment Variables** bo'limiga quyidagilarni qo'shing:

| O'zgaruvchi  | Tavsif                                                           |
|--------------|------------------------------------------------------------------|
| `BOT_TOKEN`  | @BotFather bergan bot tokeni                                     |
| `CHANNEL_ID` | Kanal ID (`-100...`) yoki `@kanal_nomi`                          |
| `SECRET`     | So'rovlarni himoyalash uchun o'zingiz o'ylab topgan maxfiy kalit |

3. Botni kanalga administrator sifatida qo'shing (xabar yuborish huquqi bilan).
4. O'zgaruvchilarni kiritgach, loyihani qayta deploy qiling.

> Token va secret qiymatlarini hech qachon kodga yoki repo'ga yozmang — faqat Vercel env o'zgaruvchilarida saqlang.

## Foydalanish

`POST /api/send` so'rovini `x-secret` sarlavhasi va JSON body bilan yuboring:

```bash
curl -X POST https://<loyiha>.vercel.app/api/send \
  -H "x-secret: ..." \
  -H "Content-Type: application/json" \
  -d '{"name":"1637-03 copy","price":"22 000","image_url":"https://..."}'
```

Body maydonlari (hammasi majburiy):

| Maydon      | Tavsif                              |
|-------------|-------------------------------------|
| `name`      | Mahsulot nomi                       |
| `price`     | Mahsulot narxi (so'mda)             |
| `image_url` | Mahsulot rasmining ochiq URL manzili |

## Javoblar

| Kod   | Ma'nosi                                                       |
|-------|---------------------------------------------------------------|
| `200` | Xabar yuborildi: `{ "ok": true, "message_id": ... }`          |
| `400` | `name`, `price` yoki `image_url` yo'q, yoki body JSON emas    |
| `401` | `x-secret` noto'g'ri yoki yo'q                                |
| `405` | So'rov `POST` emas                                            |
| `500` | Env o'zgaruvchilari yetishmaydi yoki ichki xato               |
| `502` | Telegram API xato qaytardi (`details` maydonida)              |
