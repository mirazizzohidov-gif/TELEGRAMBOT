# BITO Telegram bot (Vercel)

BITO'dagi mahsulotlarni Telegram kanallarga va Telegram Business story'ga joylovchi bot. Telegram ichida admin panel, kunlik avtomatik joylash, navbat, chegirma va "yana sotuvda" postlari bor.

## Endpointlar

| Endpoint | Himoya | Vazifasi |
|---|---|---|
| `POST /api/webhook` | `X-Telegram-Bot-Api-Secret-Token` | Telegram update'lari (admin panel, biznes ulanishlar) |
| `GET /api/setup-webhook` | `x-secret` | Webhook'ni o'rnatadi (bir marta chaqiriladi) |
| `GET /api/cron/daily` | `CRON_SECRET` yoki `x-secret` | Kunlik joylash (Vercel cron, har kuni 21:00 Toshkent) |
| `GET /api/cron/tick` | `CRON_SECRET` yoki `x-secret` | Navbatdan 10 tagacha mahsulot joylaydi |
| `POST /api/send` | `x-secret` | Bitta mahsulotni kanalga qo'lda yuborish |
| `POST /api/story` | `x-secret` | Bitta mahsulotni story qilib joylash |
| `GET /api/business-id` | `x-secret` | Saqlangan biznes ulanishlar ro'yxati |

## Environment o'zgaruvchilari

Vercel → loyiha → **Settings → Environment Variables**. O'zgartirgandan keyin **Redeploy** qiling.

| O'zgaruvchi | Majburiy | Tavsif |
|---|---|---|
| `BOT_TOKEN` | ha | @BotFather bergan bot tokeni |
| `SECRET` | ha | `x-secret` sarlavhasi uchun o'zingiz o'ylab topgan maxfiy kalit |
| `ADMIN_IDS` | ha | Admin panelga kira oladiganlarning Telegram user ID lari, vergul bilan: `123456789,987654321` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | ha* | Upstash Redis ulanishi |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | ha* | Yoki Vercel Marketplace (Upstash) avtomatik qo'shadigan o'zgaruvchilar |
| `BITO_API_KEY` | ha | BITO integratsiya kaliti, `username:secret` ko'rinishida (`api-key` sarlavhasida yuboriladi) |
| `BITO_PRICE_ID` | ha | Narx ro'yxati ID si (masalan, "Chakana (so'm)") |
| `CRON_SECRET` | tavsiya | Vercel cron shu qiymatni `Authorization: Bearer ...` qilib yuboradi |
| `WEBHOOK_SECRET` | yo'q | Webhook maxfiy kaliti. Bo'lmasa `SECRET` ishlatiladi. Faqat `A-Z a-z 0-9 _ -` bo'lmasa, uning SHA-256 xeshi ishlatiladi |
| `BITO_API_URL` | yo'q | Standart: `https://api.bito.uz/integration-api/integration/api/v2` |
| `BITO_FILE_URL` | yo'q | Standart: `https://api.bito.uz/upload-api/public` |
| `CHANNEL_ID` | yo'q | Boshlang'ich kanal (`@kanal` yoki `-100...`). Admin paneldan kanal qo'shilsa, bazadagisi ishlatiladi. `/api/send` uchun majburiy |
| `CONTACT_PHONE` | yo'q | Boshlang'ich telefon. Standart `+998982000307`. Admin panelda o'zgartiriladi |
| `ORDER_URL` | yo'q | "🛒 Buyurtma berish" tugmasi havolasi. Standart `https://t.me/Mixpodarok0307`. Admin panelda o'zgartiriladi |
| `BUSINESS_CONNECTION_ID` | yo'q | Story uchun biznes ulanish. Odatda admin paneldan tanlanadi |
| `STORY_DAILY_LIMIT` | yo'q | Kuniga ko'pi bilan nechta story. Standart `3` |
| `PROTECT_CONTENT` | yo'q | Standart: yoqilgan (postlarni forward/saqlab bo'lmaydi). O'chirish: `false` |

\* Redis uchun ikkala juftlikdan bittasi yetarli.

> Token, kalit va secret qiymatlarini hech qachon kodga yoki repo'ga yozmang — faqat Vercel env o'zgaruvchilarida saqlang.

Admin panelda saqlangan sozlama (telefon, kanallar, havola, profil) env qiymatidan ustun turadi. Bazada bo'lmasa env qiymati ishlatiladi.

## Sozlash tartibi

1. **Redis.** Vercel → loyiha → **Storage → Create Database → Upstash (Redis)** → loyihaga ulang. `KV_REST_API_URL` / `KV_REST_API_TOKEN` avtomatik qo'shiladi. (Yoki upstash.com'da baza ochib, `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` ni qo'lda kiriting.)
2. **Env.** Yuqoridagi majburiy o'zgaruvchilarni kiriting (`ADMIN_IDS` — o'z ID ingizni @userinfobot orqali bilib olasiz). Redeploy qiling.
3. **Kanal.** Botni har bir kanalga administrator qilib qo'shing (xabar yuborish huquqi bilan).
4. **Webhook.** Bir marta chaqiring:

   ```bash
   curl https://<loyiha>.vercel.app/api/setup-webhook -H "x-secret: ..."
   ```

   Shundan keyin bot Telegram'dagi xabarlarga javob beradi. `WEBHOOK_SECRET` yoki domen o'zgarsa, qayta chaqiring.
5. **Admin panel.** Botga `/start` yoki `/admin` yozing.
6. **Story (ixtiyoriy).** Telegram → Settings → Telegram Business → Chatbots → botni qo'shing va story huquqini bering. Bot ulanishni o'zi saqlaydi va adminlarga xabar beradi. Admin panelda "📱 Profil" orqali profilni tanlang va "Story" ni yoqing. Bir nechta biznes profil qo'llab-quvvatlanadi.
7. **Navbat uchun tashqi cron.** Vercel Hobby rejasida cron kuniga 1 marta ishlaydi, shuning uchun navbatni [cron-job.org](https://cron-job.org) orqali **har 15 daqiqada** chaqiring:
   - URL: `https://<loyiha>.vercel.app/api/cron/tick`
   - Method: `GET`
   - Header: `Authorization: Bearer <CRON_SECRET>` (yoki `x-secret: <SECRET>`)

## Admin panel

Faqat `ADMIN_IDS` dagi foydalanuvchilar uchun. `/start` yoki `/admin`:

| Tugma | Vazifasi |
|---|---|
| 📞 Telefon: … | Caption'dagi telefon raqamini o'zgartiradi |
| 🛒 Buyurtma havolasi | "🛒 Buyurtma berish" tugmasi havolasini o'zgartiradi |
| 📢 Kanallar | Kanal qo'shish (`@username` yoki `-100...`), o'chirish, faol/nofaol qilish |
| Kanalga yuborish ✅/❌ | Avtomatik kanal postlarini yoqish/o'chirish |
| Story ✅/❌ · 📱 Profil | Avtomatik story'ni yoqish va biznes profilni tanlash |
| Albom rejimi ✅/❌ | 2+ mahsulot bo'lsa bitta albom (sendMediaGroup) qilib yuboradi |
| 🎲 Random rejim ✅/❌ | Bugun yangi mahsulot bo'lmasa, 10 ta tasodifiy mahsulot taklif qiladi |
| 🚀 Hozir joylash | Bugungi yangi mahsulotlarni darhol navbatga qo'yib joylaydi |
| 📊 Bugungi hisobot | Bugungi statistika |

**SKU bo'yicha joylash:** botga SKU yozing (masalan `670897`). Bot mahsulot ko'rinishini (preview) yuboradi: "✅ Kanalga joylash" / "📱 Story" / "❌ Bekor".

## Avtomatik joylash qanday ishlaydi

**Kunlik (`/api/cron/daily`, har kuni 16:00 UTC = 21:00 Toshkent):**

1. BITO'dan bugun (Asia/Tashkent) qo'shilgan mahsulotlarni oladi.
2. O'tkazib yuboradi: rasmsiz, narxsiz (narx yo'q yoki 0), qoldig'i 0 (barcha filiallar yig'indisi), avval yuborilgan (takror).
3. Qolganlarini navbatga qo'yadi.
4. Bugun yangi mahsulot bo'lmasa: random rejim yoqilgan bo'lsa adminlardan "10 ta tasodifiy mahsulot joylaymi?" deb so'raydi ("✅ Ha, joyla" bosilganda tanlaydi va joylaydi); o'chiq bo'lsa hech narsa qilmaydi, faqat hisobotda yozadi.
5. Oxirgi 200 ta yuborilgan mahsulotning joriy narxi va qoldig'ini tekshiradi: narx tushgan bo'lsa **🔥 Chegirma!** (eski narx ustidan chizilgan + yangi narx), qoldiq 0 dan ko'paygan bo'lsa **✅ Yana sotuvda** posti navbatga qo'yiladi.
6. Navbatni bir marta joylaydi (tick) va adminlarga hisobot yuboradi.

**Navbat (`/api/cron/tick`):** har chaqiruvda 10 tagacha mahsulot. Albom rejimida — bitta albom va undan keyin "🛒 Buyurtma berish" tugmali qisqa xabar; aks holda har biri alohida, 3 soniya oraliq bilan, tugma bilan. Har bir faol kanalga yuboriladi. Story yoqilgan bo'lsa kuniga `STORY_DAILY_LIMIT` tagacha story. Bir chaqiruv 280 soniyadan oshmaydi; ulgurmaganlar navbatda qoladi. Telegram 429 (`retry_after`) qaytarsa kutib qayta urinadi, baribir bo'lmasa mahsulot navbatga qaytariladi.

**Hisobot:** nechta yangi mahsulot topildi, nechta joylandi, nechtasi va nima sababdan o'tkazildi (rasmsiz / narxsiz / qoldiq 0 / takror), nechta story, chegirma va yana sotuvda postlari.

## Caption

```
🛍 Mahsulot nomi: 1637-03 copy
💰 Narxi: 22 000 so'm

📞 Buyurtma uchun murojaat qiling: +998982000307
```

Kanal postlari ostida "🛒 Buyurtma berish" tugmasi bo'ladi.

## Qo'lda yuborish (`/api/send`, `/api/story`)

Body uch rejimdan birida:

```bash
# eng yangi rasmli mahsulot
curl -X POST https://<loyiha>.vercel.app/api/send \
  -H "x-secret: ..." -H "Content-Type: application/json" \
  -d '{"latest":true}'

# SKU bo'yicha
curl -X POST https://<loyiha>.vercel.app/api/send \
  -H "x-secret: ..." -H "Content-Type: application/json" \
  -d '{"sku":"1637-03"}'

# qo'lda (BITO'ga murojaat qilinmaydi)
curl -X POST https://<loyiha>.vercel.app/api/send \
  -H "x-secret: ..." -H "Content-Type: application/json" \
  -d '{"name":"1637-03 copy","price":"22 000","image_url":"https://..."}'
```

`/api/send` — `CHANNEL_ID` kanaliga yuboradi. `/api/story` — xuddi shu body, qo'shimcha `active_period` (soniya): `21600`, `43200`, `86400` (standart), `172800`. Rasm avtomatik 1080×1920 ga moslashtiriladi (oq fon, JPEG).

## Javob kodlari

| Kod | Ma'nosi |
|---|---|
| `200` | Muvaffaqiyatli |
| `400` | Maydonlar yetishmaydi, body JSON emas yoki `active_period` noto'g'ri |
| `401` | Maxfiy kalit noto'g'ri yoki yo'q |
| `404` | BITO'da mahsulot yoki narx topilmadi |
| `405` | Noto'g'ri HTTP metod |
| `500` | Env o'zgaruvchilari yetishmaydi yoki ichki xato |
| `502` | Telegram yoki BITO xato qaytardi, yoki rasmni qayta ishlab bo'lmadi |

## Eslatmalar

- `vercel.json` funksiyalarga 300 soniya beradi (Fluid compute, yangi loyihalarda standart yoqilgan). Deploy shu sababli xato bersa, **Settings → Functions → Fluid Compute** ni yoqing.
- Webhook o'rnatilgandan keyin `getUpdates` ishlamaydi — biznes ulanishlar bazaga webhook orqali yoziladi, `/api/business-id` ularni bazadan qaytaradi.
