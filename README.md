# BITO Telegram bot (Vercel)

BITO'dagi mahsulotni (rasm, nom, narx) Telegram kanalga post qiluvchi va Telegram Business orqali story joylovchi Vercel funksiyalari.

| Endpoint                | Vazifasi                                                    |
|-------------------------|-------------------------------------------------------------|
| `POST /api/send`        | Kanalga rasmli post yuboradi                                |
| `POST /api/story`       | Business hisobingizga story joylaydi                         |
| `GET /api/business-id`  | `BUSINESS_CONNECTION_ID` ni topish uchun yordamchi endpoint |

Barcha endpointlar `x-secret` sarlavhasi bilan himoyalangan.

## Environment o'zgaruvchilari

Vercel → loyiha → **Settings → Environment Variables**. O'zgartirgandan keyin **Redeploy** qiling.

| O'zgaruvchi              | Majburiy        | Tavsif |
|--------------------------|-----------------|--------|
| `BOT_TOKEN`              | ha              | @BotFather bergan bot tokeni |
| `CHANNEL_ID`             | `/api/send` uchun | Kanal ID (`-100...`) yoki `@kanal_nomi` |
| `SECRET`                 | ha              | So'rovlarni himoyalash uchun o'zingiz o'ylab topgan maxfiy kalit |
| `BITO_API_KEY`           | `latest`/`sku` uchun | BITO integratsiya kaliti, `username:secret` ko'rinishida (`api-key` sarlavhasida yuboriladi) |
| `BITO_PRICE_ID`          | `latest`/`sku` uchun | Narx ro'yxati ID si (masalan, "Chakana (so'm)") |
| `BITO_API_URL`           | yo'q            | Standart: `https://api.bito.uz/integration-api/integration/api/v2` |
| `BITO_FILE_URL`          | yo'q            | Standart: `https://api.bito.uz/upload-api/public` (mahsulot `image` yo'li oldiga qo'shiladi) |
| `PROTECT_CONTENT`        | yo'q            | Standart: yoqilgan (kanal postini forward/saqlab bo'lmaydi). O'chirish uchun `false` |
| `BUSINESS_CONNECTION_ID` | `/api/story` uchun | Business ulanish ID si (pastda qanday topish ko'rsatilgan) |

> Token, kalit va secret qiymatlarini hech qachon kodga yoki repo'ga yozmang — faqat Vercel env o'zgaruvchilarida saqlang.

Botni kanalga administrator sifatida qo'shing (xabar yuborish huquqi bilan).

## Mahsulotni tanlash (send va story uchun bir xil)

Body uchta rejimdan birida yuboriladi:

**1. Eng yangi mahsulot** — BITO'dagi eng oxirgi qo'shilgan mahsulot (`created_at` bo'yicha):

```bash
curl -X POST https://<loyiha>.vercel.app/api/send \
  -H "x-secret: ..." -H "Content-Type: application/json" \
  -d '{"latest":true}'
```

**2. SKU bo'yicha:**

```bash
curl -X POST https://<loyiha>.vercel.app/api/send \
  -H "x-secret: ..." -H "Content-Type: application/json" \
  -d '{"sku":"1637-03"}'
```

**3. Qo'lda** (BITO'ga murojaat qilinmaydi):

```bash
curl -X POST https://<loyiha>.vercel.app/api/send \
  -H "x-secret: ..." -H "Content-Type: application/json" \
  -d '{"name":"1637-03 copy","price":"22 000","image_url":"https://..."}'
```

Narx `BITO_PRICE_ID` narx ro'yxatidan olinadi va `22 000` ko'rinishida yoziladi.

## Story joylash

1. **Business ulanish.** Telegram'da: Settings → Telegram Business → Chatbots → botingizni qo'shing va story boshqarish huquqini bering.
2. **ID ni topish.** Ulagandan keyin:

   ```bash
   curl https://<loyiha>.vercel.app/api/business-id -H "x-secret: ..."
   ```

   Javobdagi `connections[].id` ni oling. Bo'sh bo'lsa — botni Business'dan olib tashlab, qayta ulang va yana so'rang. (Bu `getUpdates` orqali ishlaydi, shuning uchun botda webhook o'rnatilmagan bo'lishi kerak.)
3. **Env.** Topilgan ID ni Vercel'da `BUSINESS_CONNECTION_ID` ga yozing va Redeploy qiling.
4. **Story yuborish** (body yuqoridagi uchta rejimdan biri):

   ```bash
   curl -X POST https://<loyiha>.vercel.app/api/story \
     -H "x-secret: ..." -H "Content-Type: application/json" \
     -d '{"latest":true,"active_period":86400}'
   ```

   `active_period` (soniya): `21600` (6 soat), `43200` (12 soat), `86400` (24 soat, standart), `172800` (48 soat).

Rasm avtomatik 1080×1920 ga moslashtiriladi (oq fon, JPEG). Story uchun Telegram hisobida Premium kerak bo'lishi mumkin.

## Javoblar

| Kod   | Ma'nosi |
|-------|---------|
| `200` | Muvaffaqiyatli: `send` → `message_id`, `story` → `story_id`, `business-id` → `connections` |
| `400` | Maydonlar yetishmaydi, body JSON emas yoki `active_period` noto'g'ri |
| `401` | `x-secret` noto'g'ri yoki yo'q |
| `404` | BITO'da mahsulot yoki uning narxi topilmadi |
| `405` | Noto'g'ri HTTP metod |
| `500` | Env o'zgaruvchilari yetishmaydi yoki ichki xato |
| `502` | Telegram yoki BITO xato qaytardi, yoki rasm yuklab/qayta ishlab bo'lmadi (`details` maydonida) |
