# BITO Telegram bot (Vercel)

Telegram kanalga mahsulot rasmi, nomi va narxini yuboruvchi oddiy Vercel funksiyasi.

## O'rnatish

1. Repo'ni Vercel'ga import qiling.
2. Vercel loyihasida **Settings → Environment Variables** bo'limiga quyidagilarni qo'shing:

| O'zgaruvchi     | Tavsif                                                    |
|-----------------|-----------------------------------------------------------|
| `BOT_TOKEN`     | @BotFather bergan bot tokeni                              |
| `CHANNEL_ID`    | Kanal ID (`-100...`) yoki `@kanal_nomi`                   |
| `IMAGE_URL`     | Mahsulot rasmining ochiq URL manzili                      |
| `SECRET`        | So'rovlarni himoyalash uchun o'zingiz o'ylab topgan maxfiy kalit |
| `PRODUCT_NAME`  | Mahsulot nomi                                             |
| `PRODUCT_PRICE` | Mahsulot narxi (so'mda)                                   |

3. Botni kanalga administrator sifatida qo'shing (xabar yuborish huquqi bilan).
4. O'zgaruvchilarni kiritgach, loyihani qayta deploy qiling.

> Token va secret qiymatlarini hech qachon kodga yoki repo'ga yozmang — faqat Vercel env o'zgaruvchilarida saqlang.

## Foydalanish

`POST /api/send` so'rovini `x-secret` sarlavhasi bilan yuboring:

```bash
curl -X POST https://<loyiha-nomi>.vercel.app/api/send \
  -H "x-secret: <SECRET qiymati>"
```

## Javoblar

| Kod   | Ma'nosi                                                 |
|-------|---------------------------------------------------------|
| `200` | Xabar yuborildi: `{ "ok": true, "message_id": ... }`    |
| `401` | `x-secret` noto'g'ri yoki yo'q                          |
| `405` | So'rov `POST` emas                                      |
| `500` | Env o'zgaruvchilari yetishmaydi yoki ichki xato         |
| `502` | Telegram API xato qaytardi (`details` maydonida)        |
