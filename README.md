# BITO Telegram bot (Vercel)

BITO'dagi mahsulotlarni Telegram kanallarga va Telegram Business story'ga joylovchi bot. Telegram ichida admin panel bor. Yangi mahsulotlar va chegirmalar har 15 daqiqada avtomatik joylanadi, har kuni 16:00 da tasodifiy mahsulotlar albomi chiqadi.

## Endpointlar

| Endpoint | Himoya | Vazifasi |
|---|---|---|
| `POST /api/webhook` | `X-Telegram-Bot-Api-Secret-Token` | Telegram update'lari (admin panel, biznes ulanishlar) |
| `GET /api/setup-webhook` | `x-secret` | Webhook'ni o'rnatadi (bir marta chaqiriladi) |
| `GET /api/cron/daily` | `CRON_SECRET` yoki `x-secret` | Har kuni 16:00 Toshkent (11:00 UTC, Vercel cron): random albom + kunlik hisobot |
| `GET /api/cron/tick` | `CRON_SECRET` yoki `x-secret` | Har 15 daqiqa: yangi mahsulotlar, chegirmalar, navbat |
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
| `REDIS_URL` | ha* | **Asosiy variant.** Redis ulanishi (`redis://` yoki `rediss://`). Vercel → Storage → Redis ulanganda avtomatik qo'shiladi |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | ha* | Muqobil: Upstash REST API |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | ha* | Muqobil: Vercel Marketplace'dagi Upstash beradigan o'zgaruvchilar |
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
| `STORY_DAILY_LIMIT` | yo'q | Yangi mahsulot story'lari kunlik limiti, standart `20` |
| `DISCOUNT_STORY_DAILY_LIMIT` | yo'q | Chegirma story'lari kunlik limiti, standart `5` |
| `RANDOM_ALBUM_SIZE` | yo'q | Kunlik random albomdagi mahsulotlar soni, standart `8` (2–10) |
| `TICK_MAX_POSTS` | yo'q | Bitta tick'da kanalga yuboriladigan maksimal post, standart `10` |
| `RANDOM_REPEAT_DAYS` | yo'q | Random albomda mahsulot necha kun takrorlanmaydi, standart `7` |

Limit o'zgaruvchilari faqat standart qiymat — admin paneldagi "⚙️ Limitlar" bo'limida o'zgartirilgan qiymat bazada saqlanadi va ustun turadi.
| `PROTECT_CONTENT` | yo'q | Standart: yoqilgan (postlarni forward/saqlab bo'lmaydi). O'chirish: `false` |

\* Redis uchun bittasi yetarli. REST o'zgaruvchilari (Upstash/KV) bo'lsa `@upstash/redis` ishlatiladi, aks holda `REDIS_URL` orqali rasmiy `redis` (node-redis) paketi. Ikkala holatda ham bot bir xil ishlaydi. `REDIS_URL` ulanishi modul darajasida keshlanadi (har so'rovda yangi ulanish ochilmaydi), uzilib qolsa avtomatik qayta ulanadi.

> Token, kalit va secret qiymatlarini hech qachon kodga yoki repo'ga yozmang — faqat Vercel env o'zgaruvchilarida saqlang.

Admin panelda saqlangan sozlama (telefon, kanallar, havola, profil) env qiymatidan ustun turadi. Bazada bo'lmasa env qiymati ishlatiladi.

## Sozlash tartibi

1. **Redis.** Vercel → loyiha → **Storage → Create Database → Redis** → loyihaga ulang. `REDIS_URL` avtomatik qo'shiladi — boshqa hech narsa kerak emas. (Muqobil: Upstash — `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` yoki `KV_REST_API_URL`/`KV_REST_API_TOKEN`.)
2. **Env.** Yuqoridagi majburiy o'zgaruvchilarni kiriting (`ADMIN_IDS` — o'z ID ingizni @userinfobot orqali bilib olasiz). Redeploy qiling.
3. **Kanal.** Botni har bir kanalga administrator qilib qo'shing (xabar yuborish huquqi bilan).
4. **Webhook.** Bir marta chaqiring:

   ```bash
   curl https://<loyiha>.vercel.app/api/setup-webhook -H "x-secret: ..."
   ```

   Shundan keyin bot Telegram'dagi xabarlarga javob beradi. `WEBHOOK_SECRET` yoki domen o'zgarsa, qayta chaqiring.
5. **Admin panel.** Botga `/start` yoki `/admin` yozing.
6. **Story (ixtiyoriy).** Telegram → Settings → Telegram Business → Chatbots → botni qo'shing va story huquqini bering. Bot ulanishni o'zi saqlaydi va adminlarga xabar beradi. Admin panelda "📱 Profil" orqali profilni tanlang va kerakli story tugmalarini yoqing. Bir nechta biznes profil qo'llab-quvvatlanadi.
7. **Har 15 daqiqalik cron (`/api/cron/tick`).**
   - **Hobby (bepul) tarif:** Vercel cron kuniga faqat 1 marta ishlaydi, shuning uchun [cron-job.org](https://cron-job.org) da vazifa yarating:
     - URL: `https://<loyiha>.vercel.app/api/cron/tick`
     - Schedule: har 15 daqiqa
     - Method: `GET`
     - Header: `Authorization: Bearer <CRON_SECRET>` (yoki `x-secret: <SECRET>`)
   - **Pro tarif:** tashqi cron shart emas — `vercel.json` dagi `crons` ro'yxatiga qo'shing:

     ```json
     { "path": "/api/cron/tick", "schedule": "*/15 * * * *" }
     ```

     (Hobby'da bu qatorni qo'shmang — Vercel kuniga 1 martadan ko'p cron'li deployni rad etadi.)

## Admin panel

Faqat `ADMIN_IDS` dagi foydalanuvchilar uchun. `/start` yoki `/admin`:

| Tugma | Vazifasi |
|---|---|
| 🎲 Random albom ✅/❌ | Har kuni 16:00 da 8 ta tasodifiy mahsulotdan albom |
| 🆕 Yangi mahsulot → kanal ✅/❌ | Yangi mahsulotlarni kanallarga joylash |
| 🆕 Yangi mahsulot → story ✅/❌ | Yangi mahsulotlar uchun story |
| 🔥 Chegirma → kanal ✅/❌ | Chegirma va "✅ Yana sotuvda" postlarini kanallarga joylash |
| 🔥 Chegirma → story ✅/❌ | Chegirma uchun story |
| Albom rejimi ✅/❌ | Bir vaqtda 2+ yangi mahsulot chiqsa, albom qilib yuboradi (10 tadan) |
| ⚙️ Limitlar | Kunlik va tick limitlari (pastda) |
| 📱 Profil | Story qaysi biznes profilga joylanishi |
| 📞 Telefon | Caption'dagi telefon raqami |
| 📢 Kanallar | Kanal qo'shish (`@username` yoki `-100...`), o'chirish, faol/nofaol qilish |
| 🛒 Buyurtma havolasi | "🛒 Buyurtma berish" tugmasi havolasi |
| 🚀 Hozir joylash | 15 daqiqalik tekshiruvni darhol ishga tushiradi |
| 🎲 Random joylash | Tasodifiy N ta mahsulotni tanlab joylash (pastda) |
| 📊 Bugungi hisobot | Bugungi statistika |

Standart holat: kanalga yuborish (yangi va chegirma) yoqilgan; story'lar, random albom va albom rejimi o'chiq.

### ⚙️ Limitlar

Tugmani bosing va yangi sonni yozing. Qiymat bazada saqlanadi; noto'g'ri son yozilsa bot xato aytib, qayta so'raydi. Joriy qiymat tugma matnida ko'rinadi.

| Limit | Standart | Oraliq |
|---|---|---|
| 📱 Story kunlik limiti (yangi mahsulotlar) | 20 | 0–100 |
| 🔥 Chegirma story kunlik limiti | 5 | 0–100 |
| 🎲 Random albomdagi mahsulotlar | 8 | 2–10 |
| 📤 Bir tick'da max post | 10 | 1–50 |
| 🔁 Random takrorlanmaslik (kun) | 7 | 0–60 |

### SKU bilan qo'lda joylash

Botga SKU yozing — bitta (`670899`) yoki bir nechta, vergul yoki probel bilan (`670899, 670868 670870`, 30 tagacha). Bot mahsulotlarni BITO'dan topib, kanalda qanday ko'rinishini ko'rsatadi (bir nechta bo'lsa — albom, 10 tadan) va tugmalar beradi:

- **📢 Kanalga joylash** — faol kanallarga (2+ bo'lsa albom + "🛒 Buyurtma berish" xabari)
- **📱 Story** — har bir mahsulot uchun story
- **📢+📱 Ikkalasi**
- **🧪 Test (faqat menga)** — xuddi kanaldagidek (rasm + caption + "Buyurtma" tugmasi), lekin faqat sizga yuboriladi
- **❌ Bekor**

Qo'lda joylash takror tekshiruvini chetlab o'tadi (avval yuborilgan bo'lsa ham joylanadi, faqat eslatma chiqadi). Rasmsiz yoki narxsiz mahsulot joylanmaydi — bot ogohlantiradi. Topilmagan SKU'lar ham ro'yxatda ko'rsatiladi.

### 🎲 Random joylash

Tugmani bosing → bot "Nechta mahsulot? (1-30)" deb so'raydi → son yozing. Bot filtrdan o'tgan (rasmli, narxli, qoldig'i bor, oxirgi `Random takrorlanmaslik` kunida random'da chiqmagan) tasodifiy mahsulotlarni tanlab, albom ko'rinishida preview qiladi (10 tadan ko'p bo'lsa 10 talik albomlarga bo'linadi). Tugmalar: **📢 Kanalga joylash**, **🧪 Test (faqat menga)**, **🔄 Boshqa tanlash** (boshqa mahsulotlar), **❌ Bekor**.

## Avtomatik joylash qanday ishlaydi

### Har 15 daqiqa — `/api/cron/tick`

1. **Yangi mahsulotlar.** Oxirgi tekshiruvdan beri BITO'ga qo'shilgan mahsulotlar olinadi (vaqt bazada `last_checked_at` sifatida saqlanadi; birinchi ishga tushishda faqat oxirgi 15 daqiqa). O'tkazib yuboriladiganlar: rasmsiz, narxsiz (narx yo'q yoki 0), qoldig'i 0 (barcha filiallar yig'indisi), takror (shu SKU avval boshqa mahsulot bilan yuborilgan). Narxi, rasmi yoki qoldig'i keyinroq kiritilgan mahsulotlar 2 soat davomida qayta tekshiriladi, shuning uchun ular ham chiqadi. Hech bir mahsulot ikki marta joylanmaydi.
   - "Yangi mahsulot → kanal" yoqilgan bo'lsa — har biri alohida post (albom rejimida 2+ bo'lsa — albom).
   - "Yangi mahsulot → story" yoqilgan bo'lsa — har biri uchun story, kunlik limitgacha. Limitdan oshganlari navbatda qoladi va ertasi kuni chiqadi.
2. **Chegirma.** Bot kuzatayotgan oxirgi 200 ta mahsulot tekshiriladi (har tick'da 50 tadan, navbat bilan — 200 tasi taxminan soatda bir aylanadi). Chegirma ikki yo'l bilan aniqlanadi:
   - narx ro'yxatidagi narx avval saqlangan narxdan kamaygan;
   - mahsulotda `discount_ids` paydo bo'lgan (yoki o'zgargan) va bu chegirma avval qayd etilmagan.

   "🔥 Chegirma → kanal" yoqilgan bo'lsa kanal posti, "🔥 Chegirma → story" yoqilgan bo'lsa story (`DISCOUNT_STORY_DAILY_LIMIT` gacha, yangi mahsulot limitidan alohida). Bitta mahsulotning bitta chegirmasi uchun faqat bir marta chiqadi. Qoldig'i 0 dan ko'paygan mahsulot uchun "✅ Yana sotuvda" posti (kanalga, "Chegirma → kanal" yoqilgan bo'lsa).
3. **Navbat.** Kanal navbatidan "Bir tick'da max post" (standart 10) tagacha mahsulot (har biri 3 soniya oraliq bilan) va story navbati bajariladi. Bitta tick 280 soniyadan oshmaydi — ulgurmagani keyingi tick'ka qoladi. Telegram 429 (`retry_after`) qaytarsa kutib qayta urinadi; baribir bo'lmasa navbatga qaytariladi. Bir vaqtda ikkita tick ishlamaydi.

Chegirma caption'i:

```
🔥 CHEGIRMA!

🛍 Mahsulot nomi: 1637-03 copy
💰 Narxi: 25 000 → 22 000 so'm

📞 Buyurtma uchun murojaat qiling: +998982000307
```

Telegram'da eski narx (`25 000`) ustidan chizilgan holda ko'rinadi. Eski narx noma'lum bo'lsa (masalan, faqat `discount_ids` bo'yicha aniqlangan chegirma), faqat joriy narx yoziladi.

### Har kuni 16:00 Toshkent — `/api/cron/daily`

- **Random albom** ("🎲 Random albom" yoqilgan bo'lsa): rasmli, narxli va qoldig'i bor tasodifiy mahsulotlar (standart 8 ta, "⚙️ Limitlar"da 2–10) tanlanadi va har bir faol kanalga **bitta albom** (har rasmda o'z caption'i) qilib yuboriladi, keyin "🛒 Buyurtma berish" tugmali qisqa xabar. Oxirgi 7 kunda (sozlanadi) random albomda chiqqan mahsulotlar qaytarilmaydi. Kuniga bir marta.
- **Kunlik hisobot** adminlarga: nechta yangi mahsulot topildi, nechtasi kanalga joylandi, nechtasi va nima sababdan o'tkazildi (rasmsiz / narxsiz / qoldiq 0 / takror), nechta story, chegirmalar (topildi / kanal / story), yana sotuvda, random albom, navbatda qolganlar.

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

- Kanal postlarida "🛒 Buyurtma berish" tugmasi bor. Albom (sendMediaGroup) tugmani qo'llamaydi, shuning uchun albomdan keyin tugmali qisqa xabar yuboriladi.
- `vercel.json` funksiyalarga 300 soniya beradi (Fluid compute, yangi loyihalarda standart yoqilgan). Deploy shu sababli xato bersa, **Settings → Functions → Fluid Compute** ni yoqing.
- Webhook o'rnatilgandan keyin `getUpdates` ishlamaydi — biznes ulanishlar bazaga webhook orqali yoziladi, `/api/business-id` ularni bazadan qaytaradi.
