# BITO Telegram bot (Vercel)

Telegram kanalga mahsulot rasmi, nomi va narxini yuboruvchi oddiy Vercel funksiyasi. Mahsulot ma'lumotlari JSON body'da yuboriladi yoki faqat `sku` berilsa, BITO'dan avtomatik olinadi.

## O'rnatish

1. Repo'ni Vercel'ga import qiling.
2. Vercel loyihasida **Settings → Environment Variables** bo'limiga quyidagilarni qo'shing:

| O'zgaruvchi  | Tavsif                                                           |
|--------------|------------------------------------------------------------------|
| `BOT_TOKEN`  | @BotFather bergan bot tokeni                                     |
| `CHANNEL_ID` | Kanal ID (`-100...`) yoki `@kanal_nomi`                          |
| `SECRET`     | So'rovlarni himoyalash uchun o'zingiz o'ylab topgan maxfiy kalit |

BITO'dan avtomatik olish uchun (ixtiyoriy) qo'shimcha:

| O'zgaruvchi     | Tavsif                                                                 |
|-----------------|------------------------------------------------------------------------|
| `BITO_API_URL`  | BITO API asosiy manzili (masalan `https://.../api`)                    |
| `BITO_API_KEY`  | BITO API kaliti (`Authorization: Bearer ...` sifatida yuboriladi)      |
| `BITO_PRICE_ID` | Narx ro'yxati ID si (masalan, "Chakana (so'm)" ro'yxatining ID si)      |
| `BITO_FILE_URL` | Rasmlar manzili (`/uploads/...` oldiga qo'shiladi). Bo'lmasa `BITO_API_URL` ishlatiladi |

> BITO endpoint yo'llari `api/send.js` boshida (`BITO_PRODUCT_PATH`, `BITO_PRICE_ITEMS_PATH`). BITO hujjatlarida boshqacha bo'lsa, shu ikki qatorni o'zgartiring.

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

Yoki faqat SKU bilan (nom, narx va rasm BITO'dan olinadi):

```bash
curl -X POST https://<loyiha>.vercel.app/api/send \
  -H "x-secret: ..." \
  -H "Content-Type: application/json" \
  -d '{"sku":"670897"}'
```

Body maydonlari (`sku` bo'lmasa, uchalasi majburiy):

| Maydon      | Tavsif                              |
|-------------|-------------------------------------|
| `name`      | Mahsulot nomi                       |
| `price`     | Mahsulot narxi (so'mda)             |
| `image_url` | Mahsulot rasmining ochiq URL manzili |
| `sku`       | BITO'dagi mahsulot SKU si (ixtiyoriy) |

## Javoblar

| Kod   | Ma'nosi                                                       |
|-------|---------------------------------------------------------------|
| `200` | Xabar yuborildi: `{ "ok": true, "message_id": ... }`          |
| `400` | `name`, `price` yoki `image_url` yo'q, yoki body JSON emas    |
| `404` | `sku` bo'yicha BITO'da mahsulot topilmadi                     |
| `401` | `x-secret` noto'g'ri yoki yo'q                                |
| `405` | So'rov `POST` emas                                            |
| `500` | Env o'zgaruvchilari yetishmaydi yoki ichki xato               |
| `502` | Telegram yoki BITO API xato qaytardi (`details` maydonida)    |
