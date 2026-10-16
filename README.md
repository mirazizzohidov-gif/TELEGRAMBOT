# BITO Telegram bot (Vercel)

BITO'dagi mahsulotlarni Telegram kanallarga va Telegram Business story'ga joylovchi bot. Telegram ichida admin panel bor. Yangi mahsulotlar va chegirmalar har 15 daqiqada avtomatik joylanadi, har kuni 16:00 da tasodifiy mahsulotlar chiqadi. Kanallarga har mahsulot **alohida post** bo'lib chiqadi (rasm + to'liq matn + "🛒 Buyurtma berish" tugmasi), albom ishlatilmaydi.

## Endpointlar

| Endpoint | Himoya | Vazifasi |
|---|---|---|
| `POST /api/webhook` | `X-Telegram-Bot-Api-Secret-Token` | Telegram update'lari (admin panel, biznes ulanishlar) |
| `GET /api/setup-webhook` | `x-secret` | Webhook'ni o'rnatadi (bir marta chaqiriladi) |
| `GET /api/cron/daily` | `CRON_SECRET` yoki `x-secret` | Har kuni 16:00 Toshkent (11:00 UTC, Vercel cron): kunlik random + kunlik hisobot |
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
| `BITO_CACHE_TTL` | yo'q | BITO mahsulot/narx/chegirma keshi (soniya). Standart `600` (10 daqiqa), `0` — keshsiz |
| `BITO_TIMEOUT_MS` | yo'q | BITO so'rovi uchun kutish vaqti (ms). Standart `60000`. Timeout yoki 5xx bo'lsa 2 soniyadan keyin 1 marta qayta uriniladi |
| `BITO_DISCOUNT_PATH` | yo'q | Chegirmalar endpointi. Standart `/discount/get-all` (ishlamasa `/discount/get-paging`) |
| `LOW_STOCK_THRESHOLD` | yo'q | "Kam qoldi" chegarasi (dona), standart `3`. Admin panelda o'zgartiriladi |
| `RESTOCK_POST` | yo'q | `false` — "🔄 Qayta keldi" avtopostining standart holati o'chiq (standart yoqilgan). Admin panelda o'zgartiriladi |
| `RESTOCK_DEDUP_DAYS` | yo'q | Bitta mahsulot "🔄 Qayta keldi" bo'lib necha kunda ko'pi bilan 1 marta chiqadi, standart `7`. Admin panelda o'zgartiriladi |
| `GEMINI_API_KEY` | yo'q | "🤖 AI tavsif" uchun Google Gemini API kaliti (aistudio.google.com/apikey). Bo'lmasa postlar tavsifsiz |
| `GEMINI_MODEL` | yo'q | Gemini modeli, standart `gemini-3.8-flash` |
| `GEMINI_TIMEOUT_MS` | yo'q | Bitta Gemini so'rovini kutish vaqti (ms), standart `45000` |
| `RESTOCK_MIN_STOCK` | yo'q | "🔄 Qayta keldi" posti uchun kamida qoldiq, standart `1`. Admin panelda o'zgartiriladi |
| `RESTOCK_NIGHT` | yo'q | `false` — qayta kelganlar 23:00–08:00 da ertalabgacha kutadi (standart: kechasi ham chiqadi) |
| `RESTOCK_PER_TICK` | yo'q | Bir tick'da ko'pi bilan nechta "🔄 Qayta keldi" posti, standart `5`. Admin panelda o'zgartiriladi |
| `CHANNEL2_OWNER_ID` | yo'q | "📢 2-kanal" ni ulash/o'zgartirish huquqi bor yagona admin, standart `5812004211` (u `ADMIN_IDS` da ham bo'lishi kerak) |
| `UNSOLD_DAYS` | yo'q | "📉 Sotilmayotganlar": necha kun sotilmagan bo'lsa, standart `60`. Admin panelda o'zgartiriladi |
| `REORDER_DAYS` | yo'q | "🛒 Buyurtma qilish kerak": qoldiq necha kunga yetsa ro'yxatga tushadi, standart `7`. Admin panelda o'zgartiriladi |
| `BITO_SALES_PATH` | yo'q | Sotuv hisoboti endpointi (birinchi sinaladi). Standart `/reports/trade/by-product/pagin`, keyin `/reports/trade/items/pagin`. Odatda kerak emas |
| `BITO_UNSOLD_PATH` | yo'q | Sotilmayotganlar hisoboti endpointi (birinchi sinaladi). Standart `/reports/sales/items/unsold-paging`. Odatda kerak emas |
| `BITO_RESPONSIBLE_ID` | yo'q | Bot buyurtmasini BITO'da ham yaratish (sinov) uchun mas'ul xodim ID si |
| `BITO_ORDER_STATE` | yo'q | BITO'da yaratiladigan buyurtma holati, standart `new` |
| `BITO_ORGANIZATION_ID` | yo'q | Mahsulotda filial topilmasa BITO buyurtmasi uchun filial ID si |
| `STOCK_SCAN_PAGES` | yo'q | Katalog o'tishida bir tick'da ko'pi bilan o'qiladigan sahifalar (200 tadan), standart `40` (vaqt chegarasi bilan) |
| `DISCOUNT_SCAN_LIMIT` | yo'q | Kategoriya / barcha kategoriyalar chegirmasida e'lon qilinadigan mahsulotlar soni (BITO'ga kam so'rov). Standart `30` |
| `BITO_PRODUCT_BY_ID_PATH` | yo'q | Mahsulotni ID bo'yicha olish uchun qo'shimcha endpoint (POST `{id}`), avval shu sinaladi. Odatda kerak emas |
| `DISCOUNT_CASH_MODE` | yo'q | `apply_type: cash` chegirma ma'nosi: `subtract` (standart) — narx − value; `final` — value yangi narxning o'zi |
| `CHANNEL_ID` | yo'q | Boshlang'ich kanal (`@kanal` yoki `-100...`). Admin paneldan kanal qo'shilsa, bazadagisi ishlatiladi. `/api/send` uchun majburiy |
| `CONTACT_PHONE` | yo'q | Boshlang'ich telefon. Standart `+998982000307`. Admin panelda o'zgartiriladi |
| `ORDER_URL` | yo'q | "🛒 Buyurtma berish" tugmasi havolasi. Standart `https://t.me/Mixpodarok0307`. Admin panelda o'zgartiriladi |
| `BUSINESS_CONNECTION_ID` | yo'q | Story uchun biznes ulanish — faqat bazada hech qanday ulanish saqlanmagan bo'lsa ishlatiladi. Odatda kerak emas |
| `STORY_DAILY_LIMIT` | yo'q | Yangi mahsulot story'lari kunlik limiti, standart `20` |
| `DISCOUNT_STORY_DAILY_LIMIT` | yo'q | Chegirma story'lari kunlik limiti, standart `5` |
| `RANDOM_ALBUM_SIZE` | yo'q | Kunlik randomdagi mahsulotlar soni, standart `8` (2–10) |
| `TICK_MAX_POSTS` | yo'q | Bitta tick'da kanalga yuboriladigan maksimal post, standart `10` |
| `RANDOM_REPEAT_DAYS` | yo'q | Random'da mahsulot necha kun takrorlanmaydi, standart `7` |

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

   Shundan keyin bot Telegram'dagi xabarlarga javob beradi. Shu chaqiruv har bir admin uchun bot buyruqlarini ham o'rnatadi (`/admin`, `/random`, `/report`, `/now`) va menyu tugmasini "Commands" qiladi — oddiy foydalanuvchilarga bu buyruqlar ko'rinmaydi. `WEBHOOK_SECRET`, domen yoki `ADMIN_IDS` o'zgarsa, qayta chaqiring. (Admin avval botga kamida bir marta yozgan bo'lishi kerak, aks holda javobdagi `commands` ro'yxatida xato ko'rinadi.)
5. **Admin panel.** Botga `/start` yoki `/admin` yozing.
6. **Story (ixtiyoriy).** Har bir biznes akkauntda: Telegram → Settings → Telegram Business → Chatbots → botni qo'shing va story huquqini bering. Bot ulanishni o'zi saqlaydi, uni avtomatik ✅ qiladi va adminlarga "Yangi profil ulandi: @username" deb xabar beradi. Story'lar **barcha belgilangan profillarga** chiqadi; "📸 Istoriya profillari" bo'limida istalganini olib tashlash yoki qaytarish mumkin.
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

Faqat `ADMIN_IDS` dagi foydalanuvchilar uchun. Admin bir marta `/start` yoki `/admin` yozgandan keyin pastda **doimiy tugmalar** turadi:

| Tugma | Buyruq | Amal |
|---|---|---|
| ⚙️ Admin panel | `/admin` | Admin panel menyusi |
| 🎲 Random joylash | `/random` | "Nechta mahsulot?" deb so'raydi |
| 📊 Hisobot | `/report` | Bugungi hisobot |
| 🚀 Hozir joylash | `/now` | 15 daqiqalik tekshiruvni darhol ishga tushiradi |

Har safar `/admin` yozish shart emas. Bot javoblarida bu tugmalar yo'qolmaydi. Biror narsa so'ralgan paytda (masalan telefon) boshqa tugmani bossangiz, so'rov bekor bo'ladi.

**Oddiy foydalanuvchilar** (admin emas) botga nima yozsa ham qisqa javob oladi: "Buyurtma uchun: <telefon>" va "🛒 Buyurtma berish" tugmasi. Admin tugmalari va buyruqlari ularga ko'rinmaydi.

Admin panel menyusi (`⚙️ Admin panel`):

| Tugma | Vazifasi |
|---|---|
| 🎲 Kunlik random 16:00 ✅/❌ | Har kuni 16:00 da 8 ta tasodifiy mahsulotni joylash (har biri alohida post) |
| 🎲 Random → story ✅/❌ | Kunlik random'dagi har bir mahsulot story qilib ham joylanadi |
| 🆕 Yangi mahsulot → kanal ✅/❌ | Yangi mahsulotlarni kanallarga joylash |
| 🆕 Yangi mahsulot → story ✅/❌ | Yangi mahsulotlar uchun story |
| 🔥 Chegirma → kanal ✅/❌ | Chegirma va "✅ Yana sotuvda" postlarini kanallarga joylash |
| 🔥 Chegirma → story ✅/❌ | Chegirma uchun story |
| ⚙️ Limitlar | Kunlik va tick limitlari (pastda) |
| 📸 Istoriya profillari | Har profil holati (✅ / ❌ admin o'chirgan / ⚪️ ulanish o'chiq yoki story ruxsati yo'q, bugungi soni), ✅/❌ toggle, **🧪 Test istoriya** (tasdiqlagandan keyin oxirgi rasmli mahsulot barcha ✅ profillarga 6 soatga) |
| 🚫 Random qora ro'yxat | Random'dan butunlay chiqarilgan mahsulotlar; bosib qaytarish mumkin |
| 📞 Telefon | Caption'dagi telefon raqami |
| 📢 Kanallar | Kanal qo'shish (`@username` yoki `-100...`), o'chirish, faol/nofaol qilish |
| 🛒 Buyurtma havolasi | "🛒 Buyurtma berish" tugmasi havolasi |
| 🚀 Hozir joylash | 15 daqiqalik tekshiruvni darhol ishga tushiradi |
| 🎲 Random joylash | Tasodifiy N ta mahsulotni tanlab joylash (pastda) |
| 🔄 Qayta kelganlarni avtopost | Ombor skaneri qoldiq 0 → >0 ni aniqlaganda kanal posti + story (pastda), standart yoqilgan |
| 📊 Bugungi hisobot | Bugungi statistika |

Standart holat: kanalga yuborish (yangi va chegirma) yoqilgan; story'lar va kunlik random o'chiq.

Bosh menyuda qisqa holat: navbatdagilar, bugun kanalga joylanganlar, **📱 Bugun story: X/limit** va chegirma story'lari.

### ⚙️ Limitlar

Tugmani bosing va yangi sonni yozing. Qiymat bazada saqlanadi; noto'g'ri son yozilsa bot xato aytib, qayta so'raydi. Joriy qiymat tugma matnida ko'rinadi.

| Limit | Standart | Oraliq |
|---|---|---|
| 📱 Story kunlik limiti (yangi mahsulotlar) | 20 | 0–100 |
| 🔥 Chegirma story kunlik limiti | 5 | 0–100 |
| 🎲 Kunlik randomdagi mahsulotlar | 8 | 2–10 |
| 📤 Bir tick'da max post | 10 | 1–50 |
| 🔁 Random takrorlanmaslik (kun) | 7 | 0–60 |
| 🔄 Qayta keldi: takrorlanmaslik (kun) | 7 | 1–60 |
| 🔄 Qayta keldi: bir tick'da max | 5 | 1–50 |
| 🔄 Qayta keldi: kamida qoldiq (dona) | 1 | 1–1000 |
| 📉 Sotilmayotgan: necha kun sotilmagan | 60 | 7–365 |
| 🛒 Buyurtma qilish: qoldiq necha kunga yetsa | 7 | 1–60 |

### SKU bilan qo'lda joylash

Botga SKU yozing — bitta (`670899`) yoki bir nechta, vergul yoki probel bilan (`670899, 670868 670870`, 30 tagacha). Bot mahsulotlarni BITO'dan topib, kanalda qanday ko'rinishini ko'rsatadi (har mahsulot alohida post) va tugmalar beradi:

- **📢 Kanalga joylash** — faol kanallarga, har mahsulot alohida post ("🛒 Buyurtma berish" tugmasi bilan), 3 soniya oraliq
- **📱 Story** — har bir mahsulot uchun story
- **📢+📱 Ikkalasi**
- **🧪 Test (faqat menga)** — xuddi kanaldagidek (rasm + caption + "Buyurtma" tugmasi), lekin faqat sizga yuboriladi
- **❌ Bekor**

Qo'lda joylash takror tekshiruvini chetlab o'tadi (avval yuborilgan bo'lsa ham joylanadi, faqat eslatma chiqadi). Rasmsiz yoki narxsiz mahsulot joylanmaydi — bot ogohlantiradi. Topilmagan SKU'lar ham ro'yxatda ko'rsatiladi.

### 🎲 Random joylash

Tugmani bosing → bot "Nechta mahsulot? (1-30)" deb so'raydi → son yozing. Bot filtrdan o'tgan (rasmli, narxli, qoldig'i bor, oxirgi `Random takrorlanmaslik` kunida random'da chiqmagan) tasodifiy mahsulotlarni tanlab, har birini alohida preview post qilib ko'rsatadi. Har bir post ostida o'z tugmalari bor:

- **❌ Olib tashlash** — mahsulot tanlovdan chiqadi, preview posti o'chiriladi;
- **🔄 Almashtirish** — o'rniga boshqa mos tasodifiy mahsulot qo'yiladi (shu post yangi rasm va caption bilan yangilanadi);
- **🚫 Hech qachon** — mahsulot random qora ro'yxatiga yoziladi va boshqa hech qachon random'da (kunlik 16:00 random'da ham) tanlanmaydi.

Oxirida bitta boshqaruv xabari: **Tanlangan: N ta** (har o'zgarishda yangilanadi) va tugmalar **📢 Kanalga**, **📱 Story**, **📢+📱 Ikkalasi**, **🧪 Test (faqat menga)**, **🔄 Boshqa tanlash** (butunlay yangi tanlov), **❌ Bekor**. Joylash faqat qolgan mahsulotlarga tegishli. Kanalga har mahsulot alohida post bo'lib chiqadi. Har bir preview o'z sessiya ID si bilan bazada saqlanadi, shuning uchun bir nechta preview bir-biriga aralashmaydi.

Qora ro'yxatni admin paneldagi **🚫 Random qora ro'yxat** bo'limida ko'rish va mahsulotni bosib random'ga qaytarish mumkin.

### Story — har bir joylash turida

| Joylash turi | Story qanday yoqiladi |
|---|---|
| Yangi mahsulot (har 15 daqiqa) | "🆕 Yangi mahsulot → story" |
| Chegirma | "🔥 Chegirma → story" (alohida limit) |
| Kunlik random | "🎲 Random → story" |
| SKU bilan qo'lda | preview'dagi "📱 Story" yoki "📢+📱 Ikkalasi" |
| 🎲 Random joylash | preview'dagi "📱 Story" yoki "📢+📱 Ikkalasi" |
| 🚀 Hozir joylash | yangi mahsulot/chegirma kanal va story tugmalariga amal qiladi |

Har bir mahsulot uchun alohida story — **har bir belgilangan biznes profilga** (masalan @Mixpodarok0307 va @Shtabfoto ikkalasiga). Limitlar **har profil uchun alohida** hisoblanadi: chegirmadan boshqa barcha story'lar "📱 Story kunlik limiti"ga, chegirma story'lari "🔥 Chegirma story kunlik limiti"ga bo'ysunadi. Limitdan oshganlari story navbatida qoladi va keyingi kuni avtomatik chiqadi (qo'lda tanlanganlari avtomatik story tugmalari o'chiq bo'lsa ham chiqadi). Qo'lda joylashda bot natijani har profil bo'yicha aytadi, masalan: `📸 Istoriya: @Mixpodarok0307 ✅, @Shtabfoto ❌ Bad Request: ...`, va nechtasi navbatda qolganini.

**Barcha yo'llar bitta funksiyadan** (`postStoryToAll`, `lib/poster.js`): yangi mahsulot, chegirma, random, SKU, "🔄 Qayta keldi", test va `/api/story`. U Redis'dagi har bir ulanishni aylanib chiqadi — `is_enabled`, `can_manage_stories` ruxsati bor va admin o'chirmagan profillar — har biri alohida try/catch bilan:
- Telegram xatosida (rasm o'lchami, `BUSINESS_PEER_INVALID`, premium, limit va h.k.) **1 marta qayta urinadi**, sabab hisobotda ko'rinadi;
- logda har profil: `story -> @Shtabfoto: ok` yoki `story -> @Shtabfoto: xato <Telegram description>`;
- avtomatik story'lar (yangi mahsulot, chegirma) uchun adminga har mahsulot bo'yicha: `SKU 1234 — 📸 Istoriya: @Mixpodarok0307 ✅, @Shtabfoto ❌ <sabab>` (bir xil xato bir profil uchun soatiga bir marta) va 💡 maslahat;
- story navbati tick'da **ombor tekshiruvidan oldin** bajariladi, bitta mahsulot barcha profillarga birga yuboriladi: vaqt yetmasa mahsulot butunligicha keyingi tick'ka qoladi (bir profilga chiqib, boshqasiga jim qolib ketmaydi).

Yangi ulangan profil avtomatik ✅ bo'ladi. `/api/business-id` har ulanish uchun `story` maydonini qaytaradi: `ok` / `off` (admin o'chirgan) / `disabled` / `no_rights`, va `last_story` — shu profilga oxirgi istoriya natijasi (`{ at, sku, ok, queued, error }`, `error` — Telegram'ning aniq javobi).

"📸 Istoriya profillari"da har profil ostida oxirgi natija: `oxirgi: 15.10.2026 17:37 SKU 1061 ❌ Bad Request: BUSINESS_PEER_INVALID` (yoki ✅ / ⏳ sabab) va navbatda nechta istoriya kutayotgani. Avtomatik hisobotda kutishda qolgan profil ham ko'rsatiladi (`@Shtabfoto ⏳ kunlik limit 20`), ya'ni hech bir profil jim qolib ketmaydi. Preview tugmasida nechta profilga ketishi ko'rinadi: "📱 Story (2 profil)". Bosh menyuda: "📱 Bugun story: @a 3/20, @b 2/20".

**Story xatolari.** Jim xato bo'lmaydi: Telegram story'ni qabul qilmasa (ruxsat yo'q, biznes ulanish o'chgan, akkaunt story limiti tugagan, Premium kerak va h.k.), qaysi profilda ekani, Telegram'ning aniq xato matni (`description`) va maslahat adminga yuboriladi hamda `console.error` bilan logga yoziladi (Vercel → Logs). Avtomatik joylashda bir profildagi bir xil xato soatiga bir martadan ko'p yuborilmaydi. Bunday xatoda o'sha profilning story'lari yo'qolmaydi — navbatda qoladi va muammo hal bo'lgach chiqadi; boshqa profillar ishlashda davom etadi.

## Avtomatik joylash qanday ishlaydi

### Har 15 daqiqa — `/api/cron/tick`

1. **Yangi mahsulotlar.** Oxirgi tekshiruvdan beri BITO'ga qo'shilgan mahsulotlar olinadi (vaqt bazada `last_checked_at` sifatida saqlanadi; birinchi ishga tushishda faqat oxirgi 15 daqiqa). O'tkazib yuboriladiganlar: rasmsiz, narxsiz (narx yo'q yoki 0), qoldig'i 0 (barcha filiallar yig'indisi), takror (shu SKU avval boshqa mahsulot bilan yuborilgan). Narxi, rasmi yoki qoldig'i keyinroq kiritilgan mahsulotlar 2 soat davomida qayta tekshiriladi, shuning uchun ular ham chiqadi. Hech bir mahsulot ikki marta joylanmaydi.
   - "Yangi mahsulot → kanal" yoqilgan bo'lsa — har biri alohida post.
   - **"🆕 Yangi mahsulot → guruh"** (admin panel, standart ❌): tanlangan guruhga kanaldagi bilan bir xil mijoz posti — "🆕 Yangi mahsulot!", rasm, nomi, narx, telefon va "🛒 Buyurtma berish" tugmasi. Faqat mijozga yaroqli mahsulotlar (rasmi, narxi, qoldig'i bor), har biri bir marta. Guruh tanlanganda bot unga sinov xabarini yozadi. Kanal "🆕 Yangi mahsulot → kanal" bilan alohida boshqariladi.
   - "Yangi mahsulot → story" yoqilgan bo'lsa — har biri uchun story, kunlik limitgacha. Limitdan oshganlari navbatda qoladi va ertasi kuni chiqadi.
2. **Chegirma.** Bot kuzatayotgan oxirgi 200 ta mahsulot tekshiriladi (har tick'da 50 tadan, navbat bilan — 200 tasi taxminan soatda bir aylanadi). Chegirma ikki yo'l bilan aniqlanadi:
   - narx ro'yxatidagi narx avval saqlangan narxdan kamaygan;
   - mahsulotda `discount_ids` paydo bo'lgan (yoki o'zgargan) va bu chegirma avval qayd etilmagan.

   "🔥 Chegirma → kanal" yoqilgan bo'lsa kanal posti, "🔥 Chegirma → story" yoqilgan bo'lsa story (`DISCOUNT_STORY_DAILY_LIMIT` gacha, yangi mahsulot limitidan alohida). Bitta mahsulotning bitta chegirmasi uchun faqat bir marta chiqadi. Bot joylagan mahsulotning qoldig'i 0 dan ko'paysa "🔄 Yana sotuvda!" posti (kanalga, "Chegirma → kanal" yoqilgan bo'lsa) — "🔄 Qayta keldi" avtoposti bilan bir xil takrorlanmaslik qoidasi (N kunda 1 marta), ikki marta chiqmaydi.
3. **🔄 Qayta keldi** (pastda) — navbatdan bir tick'da ko'pi bilan 5 ta.
4. **Navbat.** Kanal navbatidan "Bir tick'da max post" (standart 10) tagacha mahsulot (har biri 3 soniya oraliq bilan) va story navbati bajariladi. Bitta tick 280 soniyadan oshmaydi — ulgurmagani keyingi tick'ka qoladi. Telegram 429 (`retry_after`) qaytarsa kutib qayta urinadi; baribir bo'lmasa navbatga qaytariladi. Bir vaqtda ikkita tick ishlamaydi.

Chegirma caption'i:

```
🔥 CHEGIRMA!

🛍 Mahsulot nomi: 1637-03 copy
💰 Narxi: 25 000 → 22 000 so'm

📞 Buyurtma uchun murojaat qiling: +998982000307
```

Telegram'da eski narx (`25 000`) ustidan chizilgan holda ko'rinadi. Eski narx noma'lum bo'lsa (masalan, faqat `discount_ids` bo'yicha aniqlangan chegirma), faqat joriy narx yoziladi.

### Har kuni 16:00 Toshkent — `/api/cron/daily`

- **Random** ("🎲 Kunlik random 16:00" yoqilgan bo'lsa): rasmli, narxli va qoldig'i bor tasodifiy mahsulotlar (standart 8 ta, "⚙️ Limitlar"da 2–10) tanlanadi va har bir faol kanalga yuboriladi — har biri **alohida post** (rasm, to'liq matn, ostida "🛒 Buyurtma berish" tugmasi), 3 soniya oraliq bilan; albom yo'q. 280 soniyaga sig'maganlari kanal navbatiga o'tadi va keyingi tick'da joylanadi. Oxirgi 7 kunda (sozlanadi) random'da chiqqan va qora ro'yxatdagi mahsulotlar tanlanmaydi. Kuniga bir marta. "🎲 Random → story" yoqilgan bo'lsa, har bir mahsulot story qilib ham joylanadi (story limiti bilan).
- **Kunlik hisobot** adminlarga: nechta yangi mahsulot topildi, nechtasi kanalga joylandi, nechtasi va nima sababdan o'tkazildi (rasmsiz / narxsiz / qoldiq 0 / takror), nechta story, chegirmalar (topildi / kanal / story), yana sotuvda, kunlik random, navbatda qolganlar.

## Chegirma narxi (BITO chegirmalari)

Bot BITO'dagi chegirmalarni (`/discount/get-all`, 10 daqiqa keshlanadi) narxga qo'llaydi — SKU, random, yangi mahsulot, kunlik random, story va `/api/send`, `/api/story` — hammasida. Chegirma hisobga olinadi, agar:

- `state` = `active` va `live_type` = `forever` (yoki hozirgi vaqt boshlanish–tugash oralig'ida);
- mahsulotga tegishli: mahsulotning `discount_ids` ida bor, yoki `item_added_ids` da mahsulot bor, yoki `is_all_categories`, yoki `category_ids` da mahsulot kategoriyasi bor;
- faqat ma'lum mijozlarga (`customer_ids`) mo'ljallangan chegirmalar e'tiborga olinmaydi.

Hisoblash: `percent` — narx × (1 − value/100); `cash` — narx − value (0 dan past emas; `DISCOUNT_CASH_MODE=final` bo'lsa value yangi narxning o'zi). Bir nechta chegirma bo'lsa — eng past narx. Masalan, Chakana narx 32 000, `cash` 17 000 → 15 000.

Chegirmali mahsulot posti:

```
🔥 CHEGIRMA!

🛍 Mahsulot nomi: …
💰 Narxi: 32 000 → 15 000 so'm      (Telegram'da 32 000 ustidan chizilgan)

📞 Buyurtma uchun murojaat qiling: …
```

Chegirmalarni olib bo'lmasa, bot asl narx bilan ishlashda davom etadi va xatoni logga yozadi.

### Faol chegirmalar avtomatik e'lon qilinadi

Har tick'da (har 15 daqiqa) bot BITO'dagi faol chegirmalarni ko'radi va ularga tegishli mahsulotlarni e'lon qiladi — **bot avval hech qachon yubormagan mahsulotlarni ham**:

- `item_added_ids` dagi mahsulotlar ID bo'yicha olinadi (keshlanadi). Bot bir nechta usulni sinaydi — `GET /product/get-by-id/{id}`, `POST /product/get-by-id` (`{_id}` / `{id}`), `POST /product/get-paging` (`ids` / `_ids` filtri) — javobda aynan shu mahsulot (`_id`) borligini tekshiradi va ishlagan usulni eslab qoladi. Hech biri ishlamasa, BITO javoblari (status, code, message) logga to'liq yoziladi;
- har bir chegirma va har bir mahsulot alohida tekshiriladi — bittasidagi xato qolganlarini to'xtatmaydi; har biri logga yoziladi: `discount X product Y: posted / skipped(nostock) / error: …`;
- chegirma tekshiruviga tick ichida alohida vaqt ajratilgan (BITO sekin bo'lsa ham boshqa bosqichlar uni "yeb qo'ymaydi");
- `customer_ids` faqat haqiqiy mijoz ID'lari bo'lsa (ya'ni `item_added_ids` dagi mahsulot ID'lari emas) chegirma mijozga xos deb hisoblanadi — BITO UI ba'zan mahsulot ID'sini u yerga ham yozadi;
- kategoriya yoki barcha kategoriyalar chegirmasida faqat birinchi `DISCOUNT_SCAN_LIMIT` (standart 30) ta mahsulot;
- rasm, narx va qoldiq (> 0) bo'lishi kerak; o'tmaganlari belgilanmaydi va keyingi tick'da qayta tekshiriladi (masalan qoldiq kelganda chiqadi);
- "🔥 Chegirma → kanal" yoqilgan bo'lsa kanal posti, "🔥 Chegirma → story" yoqilgan bo'lsa story (chegirma story limiti bilan); ikkalasi ham o'chiq bo'lsa hech narsa belgilanmaydi;
- har bir (chegirma, mahsulot) juftligi bir marta e'lon qilinadi (Redis'da belgi). Chegirma o'zgarsa (`value`, turi yoki `updated_at`) — qaytadan e'lon qilinadi; chegirma tugasa yoki o'chirilsa — belgi tozalanadi;
- "narx tushdi" tekshiruvi (bot yuborgan mahsulotlar uchun) ham ishlashda davom etadi va bir xil chegirmani ikki marta chiqarmaydi.

Admin panelda **"🔥 Chegirmalarni hozir tekshirish"** tugmasi shu tekshiruvni darhol bajaradi, navbatni joylaydi va natijani yozadi: umumiy sonlar va **har bir chegirma bo'yicha batafsil holat** — har bir mahsulot uchun ✅ e'lon qilindi / ⏭ o'tkazildi (rasmsiz, narxsiz, qoldiq 0, avval e'lon qilingan) / ❌ xato matni. Kunlik hisobotda: "🔥 Faol chegirmalar: N ta, e'lon qilingan: M ta".

Eslatma: `cash` chegirmasi narxdan katta bo'lsa yangi narx 0 bo'ladi va mahsulot "narxsiz" deb o'tkazib yuboriladi.

## Caption

```
🛍 Mahsulot nomi: 1637-03 copy
💰 Narxi: 22 000 so'm

📞 Buyurtma uchun murojaat qiling: +998982000307
```

Kanal postlari ostida "🛒 Buyurtma berish" tugmasi bo'ladi.

Har bir post turining o'z sarlavhasi bor (mijoz adashmasligi uchun 🔥 faqat chegirmada):

| Holat | Sarlavha |
|---|---|
| Yangi mahsulot (BITO'ga yangi qo'shilgan, avtomatik) | 🆕 **Yangi mahsulot!** |
| Qayta sotuvga chiqdi | 🔄 **Yana sotuvda!** |
| Chegirma (yangi mahsulot chegirma bilan ham) | 🔥 **CHEGIRMA!** — eski narx usti chizilgan |
| Qayta keldi + chegirma | 🔄 **Yana sotuvda!** — eski narx usti chizilgan |
| Random / qo'lda SKU | sarlavhasiz |

Qoldiq "⚠️ Kam qoldi" chegarasidan (⚙️ Limitlar, standart 3) oshmasa narx ostida **"⏳ Cheklangan miqdorda"** qatori (necha dona qolgani yozilmaydi) qo'shiladi (kanal posti, story va preview'da).

### 🤖 AI tavsif (Google Gemini)

Mijoz postlarida nom ostida qisqa va lo'nda tavsif: `📝 ...` — o'zbek tilida (lotin), **bitta gap**, ~110 belgigacha (masalan: "Sovg'a va telefonni bezash uchun yaltiroq 3D stikerlar."). Uslub o'zgarganda eski AI tavsiflar keyingi postda yangi uslubda qayta yoziladi; admin o'zi yozganlari (300 belgigacha) o'zgarmaydi. Gemini mahsulot **rasmi va nomi** bo'yicha yozadi; har mahsulot uchun **bir marta** yoziladi va Redis'da saqlanadi (keyingi "qayta keldi", chegirma postlarida o'sha tavsif). Gemini javob bermasa yoki xato qaytarsa, post tavsifsiz odatdagidek chiqadi (bitta mahsulot uchun soatiga bir marta qayta uriniladi).

Sozlash: **`GEMINI_API_KEY`** — Vercel → Settings → Environment Variables (kalit faylga yoki chatga yozilmaydi), keyin qayta deploy. Kalit https://aistudio.google.com/apikey dan olinadi; API to'lovi Google AI Studio / Cloud orqali alohida (Gemini ilovasi obunasi API'ni o'z ichiga olmaydi). Model standart `gemini-3.8-flash` (Google `gemini-2.5-flash` ni yangi foydalanuvchilarga yopgan), `GEMINI_MODEL` bilan o'zgartiriladi. Google model eskirdi deb boshqasini ko'rsatsa (404 "…use models/X"), bot X ga o'zi o'tadi va uni eslab qoladi.

Admin panel → **🤖 AI tavsif**:
- **🤖 AI tavsif: ✅/❌** — umuman yoqish / o'chirish (kalit bo'lmasa "❌ (kalit yo'q)");
- **📢 Kanalga**, **👥 Guruhga** ("✅ Qayta keldi" va "🆕 Yangi mahsulot → guruh"), **📱 Istoriyaga** — har biri alohida ✅/❌;
- **🧪 AI sinash** — oxirgi rasmli mahsulot uchun tavsif yozdirib, kalit ishlashini va javob vaqtini ko'rsatadi (xato bo'lsa Google'ning xato matni).

**Gemini band yoki sekin bo'lsa** (503 "high demand", 429, 500 yoki 45 soniyada javob bermasa — Gemini 3 modellari javobdan oldin "o'ylaydi"): 503/429/500 da bot 2 va 5 soniyadan keyin yana uradi; baribir bo'lmasa post tavsifsiz chiqadi, mahsulot 10 daqiqa kutadi (boshqa xatolarda 1 soat). Kutish vaqti `GEMINI_TIMEOUT_MS` bilan o'zgaradi (standart 45000). Tavsifsiz chiqqan kanal va guruh postlari eslab qolinadi: keyingi tekshiruvlarda tavsif yozilib, **o'sha post tahrirlanadi** ("📝" qo'shiladi, buyurtma tugmasi saqlanadi; 2 kungacha). Istoriyani Telegram tahrirlashga ruxsat bermaydi. "🤖 AI tavsif" oynasida: bugun yozilgan / xato / o'tkazilgan, keyin qo'shilgan postlar, kutayotganlar va oxirgi urinish (Google xatosi bilan).

`/tavsif 667142` (admin chatida) — mahsulot posti tavsif bilan, tugmalar: **🔄 AI qayta yozsin**, **✏️ O'zim yozaman**, **🗑 O'chirish**. SKU preview'da ham tavsif ko'rinadi. Kunlik hisobotda: "🤖 AI tavsif: N ta yozildi".

### 📷 Rasm va nom bo'yicha qidiruv (Gemini + BITO)

Botga mahsulot **rasmi** yuborilsa, bot uni BITO'dan topadi:
1. Gemini rasmdagi yozuvni o'qiydi — shtrix-kod, SKU yoki yorliq bo'lsa BITO'dan **aniq** topiladi ("✅ Rasmdagi kod bo'yicha topildi").
2. Yozuv bo'lmasa — Gemini mahsulotni qidiruv so'zlari bilan yozadi (o'zbekcha va ruscha), bot BITO'dan 12 tagacha nomzod oladi, Gemini rasmni nomzodlarning BITO rasmlari bilan **solishtiradi** va eng o'xshash 3 tasini (o'xshashlik 35% dan yuqori) ko'rsatadi.

| Kim | Qayerda | Nima ko'radi |
|---|---|---|
| Xodim | admin chati (rasm yuborish yoki "📷 Rasm bo'yicha qidirish" tugmasi), ombor guruhlari ("📷 Rasm bo'yicha qidirish" tugmasi → rasmni javob qilib yuborish, yoki rasm + `/rasm`) | rasm, nomi, **SKU**, narx, qoldiq (tugagan bo'lsa sanasi), o'xshashlik % |
| Mijoz | botning shaxsiy chati (rasm yuborish; `/start` da "📷 Rasm bo'yicha qidirish" tugmasi chiqadi) | mijoz kartasi: rasm, narx, **SKU**, bor-yo'qligi, "🛒 Buyurtma berish" yoki "🔔 Kelganda xabar ber"; kuniga 20 ta qidiruv |

**Nom bo'yicha:** admin chatida mahsulot nomi yozilsa (SKU emas) — rasm, nom, SKU, narx, qoldiq bilan 5 tagacha o'xshash mahsulot. Mijoz nom yozsa — kartalar SKU bilan. BITO yozilgandek topmasa, Gemini to'g'ri yozilishi, sinonimlar va o'zbekcha/ruscha variantlarni topadi va "aynan topilmadi — o'xshashlari" chiqadi.

Qidiruv 30–60 soniya olishi mumkin (bot "🔎 Qidiryapman..." deb turadi). Admin panel → 🤖 AI tavsif → **📷 Rasm bo'yicha qidiruv: ✅/❌**. Guruhda rasm ko'rinishi uchun bot admin bo'lishi yoki rasm botning xabariga javob qilib yuborilishi kerak. Kunlik hisobotda: qidiruvlar soni, topilmaganlar, xatolar.

### 🔔 Kelganda xabar ber (mijozlar uchun)

Mijoz botga shaxsiy chatda mahsulot nomi, SKU yoki shtrix-kodini yozadi — bot rasm, narx (chegirma bilan) va bor-yo'qligini ko'rsatadi (5 tagacha). Mahsulot hozir yo'q bo'lsa **"🔔 Kelganda xabar ber"** tugmasi chiqadi. Mahsulot qayta kelishi bilan (skaner 0 → >0 ni ko'rganda, avtopost yoqilgan-yoqilmaganidan qat'i nazar) bot har bir kutayotgan mijozga shaxsan yozadi: "🔔 Siz kutgan mahsulot keldi!", narx, qoldiq va "🛒 Buyurtma berish" tugmasi; obuna shu bilan tugaydi.

- `/kutish` — mijozning kutayotganlari, har birini "❌" bilan bekor qilish mumkin; bir mijoz 20 tagacha kuta oladi, obuna 90 kun saqlanadi.
- Havola: `https://t.me/<bot>?start=w_<product_id>` — to'g'ridan-to'g'ri mahsulot kartochkasini ochadi.
- Kunlik hisobotda: "🔔 Kelganda xabar ber: bugun N obuna, M kishiga xabar, kutayotganlar K".

### 📢 2-kanal (ustama narx bilan)

Ikkinchi kanal: barcha postlar unga ham chiqadi, lekin narx **ustama foiz** bilan. Narx faqat post matnida o'zgaradi — BITO'ga hech narsa yozilmaydi. 1-kanal(lar), istoriyalar va guruhlarda BITO narxi, asosiy telefon va asosiy tugma qoladi. 2-kanalning o'z telefoni va tugmasi bo'lishi mumkin (pastda).

**Ulash:** Admin panel → **📢 2-kanal ulash** → kanal `@username` yoki `-100...` ID si.
- Bot tekshiradi: `getChat`, so'ng `getChatMember`. Bot kanalda admin bo'lishi va "Xabar joylash" (`can_post_messages`) huquqi bo'lishi kerak. Bo'lmasa aniq yozadi: "Bot @kanal da admin emas" yoki "Bot @kanal da post yozish huquqi yo'q".
- Guruh yoki 1-kanallardan biri 2-kanal bo'la olmaydi.
- Sozlama Redis settings'da saqlanadi: `channel2 = { id, title, username, enabled, markup_percent, phone, order_url }`.

**2-kanal bo'limidagi tugmalar:**
- holat (kanal nomi, ✅/❌);
- **✅/❌ Yoqish/O'chirish**;
- **📈 Ustama: 30%** — 0–500 oralig'idagi butun son;
- **📞 Telefon** — 2-kanal postidagi "📞 Buyurtma uchun murojaat qiling: …" raqami, faqat `+998XXXXXXXXX` (bo'shliq va chiziqcha bilan yozsa ham bo'ladi);
- **🛒 Buyurtma tugmasi** — "🛒 Buyurtma berish" qayerga olib boradi:
  - `@username`, `t.me/...` → `https://t.me/...`;
  - `https://` havola o'zi;
  - `+998XXXXXXXXX` → `https://t.me/+998XXXXXXXXX` (Telegram shu raqamli chatni ochadi; tugmaga `tel:` havola qo'yib bo'lmaydi);
- ikkalasida ham **↩️ 1-kanaldagidek** — qiymatni bo'shatadi; bo'sh bo'lsa 1-kanal telefoni va tugmasi ishlatiladi (bo'limda "(1-kanaldagidek)" deb yoziladi);
- **🔁 Almashtirish** — ustama, telefon va tugma saqlanib qoladi;
- **🗑 Uzish** — tasdiq so'raladi.

O'zgartirishni faqat admin `5812004211` qila oladi (`CHANNEL2_OWNER_ID`), tugmalarda ham, matn javoblarida ham. Boshqa adminlar bo'limni faqat ko'radi.

**Narx:** `narx2 = floor(asl × (1 + p/100) / 1000 + 0.5) × 1000` — eng yaqin minglikka, yarmi yuqoriga yaxlitlanadi.

| Asl narx | Ustama | 2-kanal narxi |
|---|---|---|
| 16 049 | 0% | 16 000 |
| 15 600 | 0% | 16 000 |
| 15 470 | 0% | 15 000 |
| 12 345 | 30% | 16 000 |

- 0 yoki manfiy narx o'zgarmaydi (0). Musbat narx 0 ga aylanmaydi, eng kami 1 000.
- Chegirmali postda eski (ustidan chizilgan) narxga ham, chegirmali narxga ham ustama qo'shiladi, keyin yaxlitlanadi.

**Qaysi postlar 2-kanalga ketadi:** 2-kanal yoqilgan bo'lsa — kunlik 16:00 random, 15 daqiqalik yangi mahsulot, chegirma, "🔄 Qayta keldi", SKU bo'yicha post, qo'lda random, sotilmayotganlar chegirma posti. Hammasi `postToChannels` orqali o'tadi.
- 1-kanal faol bo'lmasa ham 2-kanalga chiqadi.
- 2-kanal xatosi 1-kanal va istoriyalarni to'xtatmaydi. Muvaffaqiyatsiz post 2-kanalning alohida navbatiga tushadi va keyingi tekshiruvlarda yana yuboriladi (jami 3 urinish).
- Adminga "📢 2-kanal ❌ sabab" xabari keladi (bir xil xato soatiga 1 marta).
- Dedupe alohida: bitta avtomatik post 12 soat ichida 2-kanalga ikki marta chiqmaydi (random postlar bundan mustasno — ular 1-kanalda ham ataylab takrorlanadi). 1-kanal qayta yuborilganda ham 2-kanalda takror bo'lmaydi.
- Qo'lda joylashdan keyingi javobda "📢 2-kanal (…, +30%): ✅" yoki "❌ sabab" qatori bor. "Qayta keldi" hisobotida "2-kanal ✅/❌". Kunlik hisobotda 2-kanal postlari soni.

2-kanalga ketadigan barcha postlarda shu telefon va tugma ishlatiladi. Keyinroq "📝" AI tavsif qo'shilganda ham post o'z telefoni va tugmasi bilan tahrirlanadi.

**Preview / Test:** oldindan ko'rishda postning tagida "📢 2-kanal narxi (+30%): …" va "📞 2-kanal telefoni: … · 🛒 tugma: …" yoziladi. "🧪 Test" ikkala ko'rinishni (har biri o'z telefoni va tugmasi bilan) faqat adminga yuboradi.

### 👥 Yordamchi adminlar (post joylovchilar)

Admin panel → **👥 Yordamchi adminlar**. Faqat asosiy admin `5812004211` boshqaradi (`CHANNEL2_OWNER_ID`).

**Bo'limda:**
- **➕ Qo'shish** — Telegram ID (ixtiyoriy ism bilan: `123456789 Ali`) yoki shu odamdan forward qilingan xabar. Profilini yashirgan odamning forward'idan ID olib bo'lmaydi — bot ID so'raydi. Adminni yordamchi qilib bo'lmaydi.
- **Ro'yxat**, har yordamchi uchun:
  - **📍 Manzil** — aynan BITTA kanal yoki guruh, bot admin bo'lganlar ro'yxatidan ("Sana bo'yicha yuborish"dagi kabi);
  - **🛍 Nomi / 🔖 SKU / 💰 Narxi: ✅/❌** — standart uchalasi ✅. ❌ maydon so'ralmaydi va post shablonidan o'sha qator butunlay olib tashlanadi (bo'sh qator qolmaydi). Rasm doim majburiy; sarlavha "🆕 YANGI MAHSULOT", telefon va "🛒 Buyurtma berish" tugmasi doim qoladi. Uchalasi ❌ bo'lsa post: rasm + sarlavha + telefon + tugma;
  - **✅/❌ faol**;
  - **✏️ Ism**;
  - **🗑 O'chirish** — tasdiq so'raladi.
- Yordamchi botga bir marta `/start` bosishi kerak: bot birinchi bo'lib yoza olmaydi.

**Yordamchi nima qila oladi:** faqat post yaratadi. Admin panel, sozlamalar va admin tugmalari unga ishlamaydi. Botda unga **📝 Post yaratish** tugmasi chiqadi.

**Post bosqichlari** (har birida **❌ Bekor**; faqat yoqilgan maydonlar so'raladi, raqamlash shunga qarab — masalan "1/2", "2/2"):
1. rasm (photo yoki rasm-fayl; fayl bo'lsa bot uni rasmga aylantiradi). **Faqat 1 ta rasm:** albom yoki bir nechta rasm yuborilsa, faqat birinchisi olinadi va "Faqat 1 ta rasm qabul qilinadi" deyiladi; keyingi bosqichda yana rasm yuborsa ham shunday;
2. mahsulot nomi (≤ 200 belgi);
3. SKU;
4. narx (`185000`, `185 000`, `185 000 so'm` — hammasi qabul qilinadi).

Keyin preview (postning o'zi, o'chirilgan qatorlarsiz): **✅ Joylash** / **✏️ Tahrirlash** (rasm yoki yoqilgan maydonlardan birini alohida o'zgartirish) / **❌ Bekor**. Yordamchi post yaratayotganda maydon yoqilsa, preview'dan oldin o'sha maydon ham so'raladi.

**✅ Joylash** bosilgach post asosiy admin tasdiqisiz darhol yordamchining manziliga ketadi. Shablon:

```
🆕 YANGI MAHSULOT

🛍 Mahsulot nomi: <nom>
🔖 SKU: <sku>
💰 Narxi: 185 000 so'm

📞 Buyurtma uchun murojaat qiling: <telefon>
[🛒 Buyurtma berish]
```

**Narx, telefon va tugma:**
- Manzil **2-kanal** bo'lsa — ustama narx, 2-kanal telefoni va tugmasi.
- **Boshqa manzilda** — 1-kanal telefoni va tugmasi, narx o'zgarmaydi.

**Qoidalar:**
- Manzil tanlanmagan bo'lsa yordamchiga "Asosiy admin hali manzil tanlamagan" deyiladi.
- Nom va SKU HTML sifatida escape qilinadi (injection'dan himoya).
- Bir bosish = bitta post: qayta bosilsa yoki webhook takrorlansa ikki marta chiqmaydi.

**Har joylashdan keyin** asosiy adminga nusxa keladi: "👤 <ism> joyladi → <manzil>: <nom>, SKU …" va postning o'zi. Joylanmasa (masalan bot huquqi yo'q) yordamchiga sabab va **🔁 Qayta urinish** chiqadi, asosiy adminga "❗ … joylay olmadi" xabari boradi.

### 📅 Sana bo'yicha yuborish

Admin panel → **📅 Sana bo'yicha yuborish**. Faqat admin `5812004211` ishlata oladi (`CHANNEL2_OWNER_ID`).

Bosqichlar:

1. **Sana:** "Bugun", "Kecha" yoki "✏️ Sana yozish" (`DD.MM.YYYY`, Toshkent vaqti, kelajak sana emas).
2. **Turi:**
   - 🆕 **Yangi** — shu kuni BITO'da yaratilgan mahsulotlar;
   - 🔄 **Qayta kelgan** — shu kuni ombor skaneri 0 → >0 deb qayd qilganlar (tarix 9 kun saqlanadi);
   - **Ikkalasi** — ikkala ro'yxat; mahsulot ikkalasida bo'lsa "yangi" hisoblanadi.
3. **Manzil — bittasi:** bot admin bo'lgan kanal va guruhlar ro'yxatidan, nomi bilan:
   - 1-kanal(lar), 2-kanal;
   - ombor va boshqa guruhlar;
   - bot admin qilib qo'shilgan kanallar (`my_chat_member` orqali eslab qolinadi).
4. **Tasdiq:**
   - "Topildi: N ta (yangi X, qayta kelgan Y)" va o'tkaziladiganlar soni (sababi bilan);
   - birinchi mahsulot qanday chiqishining namunasi;
   - **✅ Yuborish** / **❌ Bekor**.

Har mahsulot alohida post, format:

```
🆕 YANGI MAHSULOT            (yoki 🔄 YANA SOTUVDA!)

🛍 Mahsulot nomi: ...
🔢 SKU: ...
💰 Narxi: 12 000 so'm          (chegirmada: <s>15 000</s> 12 000 so'm)

📞 Buyurtma uchun murojaat qiling: <telefon>
[🛒 Buyurtma berish]
```

Narx, telefon va tugma:
- **2-kanalga** — ustama narx, 2-kanal telefoni va tugmasi.
- **Boshqa manzilga** — BITO narxi, 1-kanal telefoni va tugmasi.

Qaysi mahsulotlar o'tkaziladi:
- rasmsiz;
- narxsiz;
- qoldig'i hozir 0.

Yuborish:
- **Avval tekshiruv:** bot manzilda admin ekani (kanalda "Xabar joylash" huquqi) tekshiriladi; bo'lmasa aniq xato chiqadi.
- **Tezlik:** postlar orasida 3 soniya.
- **Progress:** "📤 Yuborildi 12/40" xabari yangilanib turadi.
- **Ko'p bo'lsa:** tugma bosilganda ~4 daqiqa ichida sig'ganicha yuboriladi (Vercel 300 s chegarasi). Qolgani har 15 daqiqalik tekshiruvda davom etadi. Telegram 429 bilan uzoq kutishni so'rasa ham shunday.
- **Oxirida hisobot:** yuborildi N; o'tkazildi M — sabablari va SKU'lari bilan.
- **Takrorlanmaslik:** sana + manzil + mahsulot bo'yicha eslab qolinadi (90 kun). Qayta bosilsa "allaqachon yuborilgan, yana yuborilsinmi?" deb so'raladi: **🔁 Ha, hammasini** yoki **➡️ Faqat yuborilmaganlarini**.
- **Navbat:** bir vaqtda bitta yuborish ishlaydi.

### 🛒 Bot ichida buyurtma

Postlardagi, kartochkalardagi va "🔔 keldi" xabaridagi **"🛒 Buyurtma berish"** tugmasi botni ochadi (`https://t.me/<bot>?start=o_<product_id>`). Bot so'raydi:

1. **Nechta?** — 1–5 tugmalari yoki "✏️ Boshqa son" (qoldiqdan ko'p bo'lmaydi);
2. **Telefon** — "📱 Raqamni yuborish" tugmasi yoki yozib;
3. **Manzil** — matn, "📍 Lokatsiyani yuborish" yoki "🏪 O'zim olib ketaman";
4. **Tasdiqlash** — jami summa bilan.

Buyurtma (#raqam bilan) admin panel → **🛒 Buyurtmalar** da tanlangan guruhga (yoki adminlarga) "✅ Qabul qilindi / ❌ Bekor qilish" tugmalari bilan keladi; xodim bosganda xabar yangilanadi va mijozga xabar boradi. Mijoz istalgan vaqtda "❌ Bekor qilish" bilan chiqadi. Bot username'ini o'zi aniqlaydi (`getMe`).

- **🛒 Buyurtma bot ichida: ✅/❌** — o'chirilsa tugma avvalgidek menejer havolasini (`order_url`) ochadi.
- **🧾 BITO'da ham yaratish (sinov)** — yoqilsa bot BITO'da mijozni telefon bo'yicha topadi (yo'q bo'lsa yaratadi) va sale order yaratadi. Vercel'da `BITO_RESPONSIBLE_ID` kerak. Bu BITO API qismi hujjatlanmagan, shuning uchun sinov rejimida: natija yoki BITO xatosi har buyurtma xabarida yoziladi, buyurtma baribir guruhga keladi.

### 🗂 Katalog (mijozlar uchun)

Mijoz botda **🗂 Katalog** tugmasini bosadi (yoki `/katalog`): BITO kategoriyalari (asosiylari, keyin ichki kategoriyalar, masalan "Sovg'alar → Krujka"), qavsda sotuvdagi mahsulotlar soni; bo'sh kategoriyalar ko'rinmaydi. Kategoriya ichida mahsulotlar rasm, narx (chegirma bilan), SKU va "🛒 Buyurtma berish" tugmasi bilan 5 tadan chiqadi ("➡️ Yana").

### 📊 Savdo tahlili (admin panel)

BITO "sotuv — mahsulot bo'yicha" hisobotidan:

- **📉 Sotilmayotganlar** — sotuvda bor, lekin oxirgi N kunda (standart 60) bitta ham sotilmagan mahsulotlar, eng ko'p pul yotganlari birinchi. Ro'yxat ostida mahsulot tanlanadi → chegirma foizi (10/15/20/30%) → oldindan ko'rish → **✅ Kanalga joylash** bilan chegirma posti chiqadi. Kassada ham shu narx bo'lishi uchun BITO'da ham chegirma qo'ying (bot eslatadi).
- **🛒 Buyurtma qilish kerak** — oxirgi 14 kunda kamida 2 dona sotilgan va qoldig'i shu tezlikda N kundan (standart 7) kamga yetadigan mahsulotlar: qoldiq, kuniga necha dona, necha kunga yetadi. Har kuni ombor ro'yxati vaqtida avtomatik hisobot guruhiga (yoki adminlarga) keladi — **🛒 Har kuni ro'yxat bilan: ✅/❌**.
- **📈 Haftalik hisobot** — har dushanba adminlarga: hafta sotuvi (so'm, dona), tugagan va qayta kelganlar soni, buyurtma qilish kerak / sotilmayotganlar soni, eng ko'p sotilgan 10 ta, Gemini yoqilgan bo'lsa qisqa AI xulosasi. "📈 Haftalik hisobot (hozir)" bilan istalgan vaqtda.

**Endpointlar** (BITO Integration API, docs.bito.uz/api/report-sales.html — yo'l `/reports/...`, ko'plikda; hammasi POST):

| Nima uchun | Endpoint |
|---|---|
| Sotuv (buyurtma qilish kerak, haftalik hisobot, sotilmayotganlar zaxira usuli) | `/reports/trade/by-product/pagin` (keyin `/reports/trade/items/pagin`) |
| 📉 Sotilmayotganlar | `/reports/sales/items/unsold-paging` |

- **So'rov tanasi:** `{ page, limit: 200, date_from, date_to, from_date, to_date }`. Sanalar Toshkent vaqtida (`…T00:00:00+05:00` / `…T23:59:59+05:00`); `from_date` / `to_date` ehtiyot uchun qo'shimcha yuboriladi.
- **Javob:** `{ data: { list, total } }` yoki `{ data: { data, total, total_amounts | total_data } }` — ikkalasi ham o'qiladi.
- **Sotuv qatorlari moslashuvchan o'qiladi:**
  - har bir sotilgan qator: `{ amount, total_price, product: { _id, name } }` — bekor qilinganlari tashlanadi;
  - yoki mahsulot jami: `{ product_id, product_name, items_sold, items_refunded, net_sales }`;
  - ikkala holatda ham bot mahsulot bo'yicha o'zi qo'shib chiqadi.
- **Sotilmayotganlar:** hisobotdan `quantity > 0` va `items_sold = 0` bo'lgan qatorlar olinadi. SKU va narx ombor yozuvlaridan to'ldiriladi, "omborda N kun" ham ko'rsatiladi. Bu hisobot ishlamasa yoki filtrlamasa (hamma qatorda sotuv bor), ro'yxat sotuv hisobotidan hisoblanadi: sotuvda bor, lekin davrda sotilmagan.
- `BITO_SALES_PATH` / `BITO_UNSOLD_PATH` berilsa, ular birinchi sinaladi. Ishlagan yo'l eslab qolinadi; topilmasa xato aniq yoziladi (har bir yo'l va BITO javobi) va keyingi tick'da qayta urinadi.

### 🔄 Qayta keldi — avtopost

Ombor skaneri ("📦 Ombor guruhi" tanlangan bo'lishi kerak) mahsulot qoldig'i 0 → >0 ga o'tganini ko'rsa (guruhdagi "✅ QAYTA KELDI" xabari bilan bir vaqtda), mahsulot "🔄 Qayta keldi" navbatiga tushadi va har bir faol kanalga post hamda barcha belgilangan business profillarga story (1080×1920) qo'yiladi:

```
🔄 Yana sotuvda!

🛍 Mahsulot nomi: Modelcar platik Gelik g63 d704-22
💰 Narxi: 120 000 → 108 000 so'm      (chegirma bo'lsa eski narx usti chizilgan)

📞 Buyurtma uchun murojaat qiling: +998982000307
```

Qoidalar:
- **Faqat haqiqiy o'tish:** mahsulot oldin skanerda 0 deb yozilgan bo'lishi va katalog kamida bir marta to'liq tekshirilgan bo'lishi kerak. Birinchi to'liq tekshiruv (tarix yo'q), kategoriya bosilganda BITO'dan qayta o'qish, qidiruv va `/sku` kartochkasi hech narsa post qilmaydi.
- **Takrorlanmaslik:** bitta mahsulot 7 kunda (⚙️ Limitlar, 1–60) ko'pi bilan 1 marta — Redis kaliti `bito:flag:restock:<product_id>`.
- **Bir tick'da ko'pi bilan 5 ta** (⚙️ Limitlar, 1–50), eng avval qaytganlari birinchi; qolganlari navbatda keyingi tick'larni kutadi. Navbat soni admin panel boshida: "Navbatda: … qayta keldi N".
- **Kechasi ham chiqadi** ("🌙 Qayta kelganlar kechasi ham: ✅", standart). ❌ qilinsa, 23:00–08:00 (Toshkent) navbatda turadi va 08:00 dan keyin chiqadi.
- **Kamida qoldiq** (⚙️ Limitlar, standart 1): qoldiq shundan kam bo'lsa post qilinmaydi va adminga aytiladi (`o'tkazib yuborildi (qoldiq 2 < 3)`). Standart 1 — har qanday qayta kelgan mahsulot kanalga va istoriyaga chiqadi.
- Skaner "📦 Ombor guruhi" tanlanmagan bo'lsa ham ishlaydi (avtopost yoki kutayotgan mijoz bo'lsa) — guruhga xabarlar esa faqat guruh tanlanganda.
- Joylashdan oldin mahsulot BITO'dan yangidan olinadi: qoldig'i yana 0 bo'lsa, rasmsiz yoki narxsiz bo'lsa — o'tkazib yuboriladi (mavjud qoida bo'yicha) va adminga aytiladi.
- Story'lar mavjud kunlik story limitiga bo'ysunadi; limitdan oshgani story navbatida qoladi va keyinroq chiqadi.
- "🔄 Qayta kelganlarni avtopost: ❌" bo'lsa navbat tozalanadi va hech narsa navbatga tushmaydi.
- Har tick'dan keyin adminlarga qisqa hisobot: `🔄 Qayta keldi: 668946 — kanal ✅, istoriya 2/2 ✅` (yoki xato / "navbatda" / "o'tkazib yuborildi (rasmsiz)"). Kunlik hisobotda: "🔄 Qayta keldi (ombor): N aniqlandi, M kanalga joylandi".

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

## 📦 Ombor guruhi (tugagan mahsulotlar)

Bot qo'shilgan guruhlarni o'zi eslab qoladi (adminlarga "📦 Bot guruhga qo'shildi" xabari keladi). Admin panel → **📦 Ombor guruhi**: guruhni tanlang va funksiyalarni ✅/❌ qiling. Guruh tanlanganda bot unga buyruqlarni o'rnatadi va pastda doimiy tugmalar chiqaradi. Hamma xabarlar mahsulot **rasmi** bilan.

**Hisobot o'zini tozalaydi.** Tugaganlar hisoboti (kunlik ro'yxat, "📤 Hisobotni hozir yuborish", tekshiruvdan keyingi hisobot) yuborilganda bot uning har bir xabarini eslab qoladi (Redis):
- **mahsulot qayta kelsa** — hisobotdagi uning rasmi va "❌ TUGADI" xabari o'chiriladi, matnli ro'yxatdan uning qatori olib tashlanadi ("Tugagan mahsulotlar: N ta" soni ham kamayadi). Telegram 48 soatdan eski xabarni o'chirishga ruxsat bermaydi — unday xabarning izohi "✅ QAYTA KELDI — nomi (SKU), sana" ga o'zgartiriladi;
- **yangi hisobot yuborilganda** — oldingi hisobotning hamma xabarlari (matn, albomlar, tugmalar, progress) va undan oldingi "❌ TUGADI" xabarlari o'chiriladi (`deleteMessages`, 100 tadan), guruhda faqat oxirgi, to'g'ri hisobot qoladi. "✅ QAYTA KELDI" xabarlari o'chirilmaydi.

Bot guruhda o'z xabarlarini o'chira oladi; admin qilinsa yanada ishonchli.

**Alohida guruhlar.** "📦 Ombor guruhi"da uchta tugma: **❌ Tugadi xabarlari → …**, **✅ Qayta keldi xabarlari → …**, **📋 Tugaganlar hisoboti → …**. Har birini bosib bot qo'shilgan istalgan guruhni tanlash mumkin (yoki "Asosiy ombor guruhi"). Tanlanganda bot o'sha guruhga sinov xabarini yozadi (yozib bo'lmasa adminga aytadi). Tanlanmaganlari asosiy ombor guruhiga boradi. Kunlik ro'yxat va "📤 Hisobotni hozir yuborish" — hisobot guruhiga. Guruh buyruqlari (/tugagan, /kam, /bugun …) va ro'yxat tugmalari barcha shu guruhlarda ishlaydi.

**Qoldiq tarixi.** Bot har tick'da (15 daqiqa) eng yangi mahsulotlarni (2 sahifa), o'zi joylagan mahsulotlarni va **butun katalogni** (200 talik sahifalar, vaqt yetgancha — odatda ~5600 mahsulot bitta tick'da; ulgurmagani keyingi tick'da Redis kursor bilan davom etadi) ko'radi va qoldiqni saqlaydi. O'tish tugashi bilan keyingisi boshlanadi. BITO mahsulotlarni `updated_at` bo'yicha saralab bermaydi, shuning uchun istalgan mahsulotning tugashi yoki qayta kelishi ("✅ QAYTA KELDI" va "🔄 Qayta keldi" avtoposti) shu tarzda 15–30 daqiqa ichida ko'rinadi. Qoldiq — barcha omborlar (`organizations[].amount`) yig'indisi; faqat sotiladigan (`is_product`), arxivlanmagan mahsulotlar hisobga olinadi. BITO'dan o'chirilgan mahsulotlar keyingi to'liq o'tishdan keyin ro'yxatdan chiqadi. Qoldiq > 0 dan 0 ga tushgan vaqt — "tugagan sana" (Toshkent vaqti). Bot kuzatishni boshlashdan oldin tugaganlar uchun BITO `updated_at` taxminiy sana sifatida ko'rsatiladi: `~14.10.2026`.

**Darhol xabar** ("🔔 Darhol xabar" ✅): qoldiq 0 ga tushsa —

```
❌ TUGADI
🛍 <nomi>
🔢 SKU: <sku>
💰 Narxi: <narx> so'm
📦 Qoldiq: 0
📅 Tugagan sana: dd.mm.yyyy HH:MM
```

0 dan ko'paysa — "✅ Qayta keldi xabarlari" guruhiga **mijozlar uchun post**, kanaldagi bilan bir xil: "🔄 Yana sotuvda!", rasm, nomi, mijoz to'laydigan narx (chegirmada eski narx usti chizilgan), kam qolsa "⏳ Cheklangan miqdorda", telefon va "🛒 Buyurtma berish" tugmasi. Har o'zgarish bir marta.

Xodimlar formati (SKU, qoldiq, sana) faqat "❌ TUGADI" xabarlari, tugaganlar hisoboti va guruh buyruqlarida (/tugagan, /kam, /bugun, /sku) qoladi; mijozlar ko'radigan hamma narsa (kanal, istoriya, "✅ Qayta keldi" va "🆕 Yangi mahsulot" guruhlari) mijoz formatida.

**Guruh buyruqlari** ("💬 Guruh buyruqlari" ✅, faqat tanlangan guruhda, guruhning istalgan a'zosi):

| Buyruq / tugma | Natija |
|---|---|
| `/tugagan` · ❌ Tugaganlar | Barcha tugagan mahsulotlar (pastda) |
| `/kam` · ⚠️ Kam qolganlar | Qoldig'i chegaradan (standart 3) kam yoki BITO'dagi `red_line` / `yellow_line` dan past mahsulotlar |
| `/bugun` · 📅 Bugun tugaganlar | Bugun tugagan va qayta kelganlar |
| `/sku 3147` · 🔎 SKU qidirish | Mahsulot kartochkasi (rasm, nomi, narx, qoldiq, 0 bo'lsa tugagan sana) |
| `/kategoriyalar` · 📊 Kategoriya statistikasi | BITO kategoriyalari statistikasi: asosiylari, ichkilari qo'shib hisoblanadi (pastda) |
| `/kategoriya` · 📂 Kategoriyalar | Asosiy kategoriyalar (nomi va mahsulotlar soni, ichki kategoriyalari bilan), 10 tadan "⬅️/➡️" bilan; tanlanganda: 📦 Hammasi / ❌ Tugaganlar / ⚠️ Kam qolganlar / ✅ Bor (sotuvda) |
| `/qidir blaknot` · 🔎 Qidirish | Nom qismi, SKU yoki shtrix-kod bo'yicha BITO'dan qidirish, holat bo'yicha saralash tugmalari bilan |
| `/tugagan blaknot`, `/kam blaknot` | Shu kategoriyadagi tugagan / kam qolganlar (nomning bir qismi ham bo'ladi) |

Privacy mode yoqilgan bo'lsa ham buyruqlar va "🔎 SKU qidirish" (botga javob orqali) ishlaydi. Pastdagi tugmalar oddiy matn yuboradi — ular ishlashi uchun botni guruhda **admin** qiling (yoki @BotFather → /setprivacy → Disable). Admin panel bu haqda ogohlantiradi.

**📊 Kategoriya statistikasi** (`/kategoriyalar`). Kategoriyalar ro'yxati BITO'ning o'zidan olinadi (`/category/get-paging`, barcha sahifalar, 10 daqiqa keshlanadi) — skanerni kutmasdan. Xabar boshida:

```
📂 BITO'da jami 563 ta kategoriya (asosiy: 41 ta, ichki: 310 ta, bo'sh: 212 ta) | 📦 jami mahsulot 5627 | ❌ tugagan 412 | ⚠️ kam 96 | ✅ bor 5215
🕘 Oxirgi to'liq tekshiruv: 15.10.2026 06:10        (yoki "to'liq emas — 400/5627")
```

Kategoriyalar ierarxik (`parent_id`, `child_count`, `item_count`): **asosiy** — `parent_id` yo'q (yoki ota-kategoriyasi ro'yxatda yo'q), **ichki** — boshqa kategoriya ichidagilar, **bo'sh** — `item_count` 0, `child_count` 0 va keshda mahsuloti yo'q kategoriyalar (yashiriladi). Asosiy + ichki + bo'sh = BITO'dagi kategoriyalar soni.

Keyin faqat **asosiy kategoriyalar** bir qatorda — `Nomi — jami 120 | ❌ 15 | ⚠️ 4 | ✅ 101`; har biriga barcha ichki kategoriyalaridagi (har qanday chuqurlikda) mahsulotlar ham qo'shib hisoblanadi (standart: eng ko'p tugagani tepada; "Kategoriyasiz" qatori ham bor), 4096 belgi limitiga qarab bo'linadi, oxirida `bo'sh: K ta`. Pastda tugmalar: "Saralash: ❌ ko'p tugagan / 🔤 nom / 📦 ko'p mahsulot" va 10 tadan sahifali asosiy kategoriyalar "Nomi (❌15)":
- ichki kategoriyasi bor kategoriya bosilsa — xulosa (`📂 Sovg'alar › Blaknot: jami …`), **📦 Hammasi (N | ❌n)** tugmasi (butun shoxcha bo'yicha tugaganlar + filtrlar), ichki kategoriyalar "Nomi (120 | ❌15)" (bo'shlari yashirin, 10 tadan "⬅️/➡️") va "⬆️ Ota-kategoriya" — sahifalash va ⬆️ o'sha xabarni tahrirlaydi;
- ichki kategoriyasi yo'q kategoriya bosilsa — uning tugaganlari darhol rasm bilan, yonida ⚠️ Kam / ✅ Bor / Hammasi filtrlari.

Tugagan / kam / bor sonlari katalog keshidan (skaner `product.category` ni ham saqlaydi); katalog to'liq tekshirilmagan bo'lsa "jami" shoxchadagi `item_count` lar yig'indisidan (keshdagidan katta bo'lsa) olinadi, sonlar "to'liq emas" deb belgilanadi va tekshiruv progress bilan boshlanadi. "📂 Kategoriyalar" ham asosiy kategoriyalarni (mahsuloti borlarini) "Nomi (120 | ❌15)" ko'rinishida chiqaradi; ichki kategoriyasi borlari ichki ro'yxatni ochadi. `/tugagan blaknot`, `/kam sovg'a` va filtrlar ham kategoriyaning barcha ichki kategoriyalarini qamraydi (nom bo'yicha qidiruv ichki kategoriyalarni ham topadi).

Kategoriya bosilganda (yoki `/tugagan <kategoriya>`) uning mahsulotlari BITO'dan `category_id` bo'yicha (ichki kategoriyalari bilan, har biriga 5 sahifagacha, ~25 soniya) qayta o'qiladi — katalog tekshiruvi hali yetib bormagan bo'lsa ham kategoriya to'g'ri chiqadi. Mahsulot kategoriyasi BITO'ning har xil ko'rinishlaridan o'qiladi (`category` obyekt yoki id, `category_id`, `categories[]`). Kategoriyalarni saqlamagan eski versiyaning to'liq tekshiruvi hisobga olinmaydi — keyingi so'rovda yangi tekshiruv boshlanadi. BITO kategoriyalar ro'yxati vaqtincha ochilmasa, oxirgi saqlangan ro'yxat (nomlar va ierarxiya) ishlatiladi. `/sku 668946` kartochkasidan keyin kategoriya yo'li chiqadi (`📂 Kategoriya: O'yinchoqlar › …`) yoki nega "Kategoriyasiz"ligi va BITO'dagi kategoriya maydonlari.

**Kategoriya va qidiruv natijalari** umumiy formatda: xulosa ("📂 Blaknot: jami N, tugagan A, kam B, bor C"), matnli ro'yxat (`1. nomi — SKU — qoldiq — narx — tugagan sana`; narx ma'lum bo'lsa), keyin rasmlar 10 talik albomlarda (nomi, SKU, narx, qoldiq, tugagan sana), 50 tadan ko'p bo'lsa "➡️ Keyingi". Kategoriyalar katalog keshidan (mahsulotlarning `category` maydoni) olinadi. Guruhning istalgan a'zosi ishlata oladi, lekin faqat tanlangan ombor guruhida.

**Tugaganlar ro'yxati (`/tugagan`, "❌ Tugaganlar").**

1. `📋 Tugagan mahsulotlar: N ta (yangilangan: dd.mm.yyyy HH:MM)` va to'liq matnli ro'yxat — `1. nomi — SKU 3147 — 14.10.2026 12:30` (Telegram'ning 4096 belgi limitiga qarab bir nechta xabarga bo'linadi; rasmsizlar "(rasmsiz)" belgisi bilan faqat shu yerda).
2. Rasmlar 10 talik albomlarda (har rasmda nomi, SKU, narx, "📦 Qoldiq: 0", "📅 Tugagan sana"), albomlar orasida 2,5 soniya pauza. Bir martada 50 ta rasm, keyin **"➡️ Keyingi 50 ta rasm"** tugmasi.

Katalog hali to'liq tekshirilmagan bo'lsa (masalan bot endigina qo'shilgan), bot hech qachon bo'sh "0" ko'rsatmaydi. Hozirgacha topilganlar "(to'liq emas — 400/5627 tekshirildi)" belgisi bilan ko'rsatiladi va tekshiruv darhol boshlanadi / davom etadi. Progress xabari (ko'pi bilan har 3 soniyada yangilanadi):

```
🔄 Katalog tekshirilmoqda...
🔄 Tekshirildi: 400 / 5627 mahsulot
❌ Hozircha tugagan topildi: 37 ta
⚠️ Kam qolgan: 12 ta
✅ Sotuvda: 351 ta
⏳ Taxminiy qolgan vaqt: ~3 daqiqa
```

Tugaganda: "✅ Tekshiruv tugadi: 5627 ta mahsulot tekshirildi. ❌ Tugagan: N ta, ⚠️ Kam qolgan: M ta" va keyin umumiy ro'yxat (matn + rasmlar). Vaqt yetmasa, tekshiruv keyingi tick'da davom etadi va natija guruhga **avtomatik** yuboriladi. "❌ Tugaganlar", kategoriyalar va "📤 Hisobotni hozir yuborish" tekshiruv ishlamayotgan bo'lsa uni o'zi boshlaydi. Admin panelda **"🔄 Katalogni hozir to'liq tekshirish"** tugmasi ham bor.

**Kunlik ro'yxat** ("📋 Kunlik ro'yxat" ✅, standart 09:00 Toshkent, admin panelda o'zgartiriladi): "📋 Bugungi hisobot: tugagan N ta, kam qolgan M ta" va yuqoridagi formatdagi to'liq ro'yxat. Katalog hali to'liq tekshirilmagan bo'lsa — tekshiruv tugagach yuboriladi. "📤 Hisobotni hozir yuborish" tugmasi — darhol.

`/api/setup-webhook` ni qayta chaqiring — `my_chat_member` update'lari va guruh buyruqlari o'rnatiladi.

## Tezlik va javob

- **Webhook darhol javob beradi.** Telegram'ga HTTP 200 darhol qaytariladi, ish esa `waitUntil` (`@vercel/functions`) orqali fonda davom etadi — sekin javob Telegram'ni update'ni qayta yuborishga majbur qilmaydi. Har bir `update_id` Redis'da 10 daqiqa saqlanadi va takrorlari o'tkazib yuboriladi.
- **Tugma bosilganda** birinchi bo'lib `answerCallbackQuery` ("⏳ Bajarilmoqda...") yuboriladi. Uzoq amallarda bot darhol xabar yozadi ("🔎 SKU 670899 qidirilmoqda...", "🚀 Yangi mahsulotlar tekshirilmoqda...", "⏳ 3 ta mahsulot joylanmoqda...") va keyin o'sha xabarni natija bilan tahrirlaydi.
- **"🚀 Hozir joylash" har doim natija yozadi:** "Yangi mahsulot topilmadi (oxirgi tekshiruv: HH:MM)" yoki "N ta topildi: X ta kanalga, Y ta story; o'tkazildi: rasmsiz A, narxsiz B, qoldiq 0 C, takror D", joylangan SKU'lar ro'yxati, xato bo'lsa xato matni.
- **BITO:** har bir so'rov vaqti logga yoziladi (`BITO /product/get-paging {...} -> 200 in 340 ms (attempt 1)` — Vercel → Logs). BITO sekin javob berishi mumkin, shuning uchun 60 soniya kutiladi (`BITO_TIMEOUT_MS`); timeout yoki 5xx bo'lsa 2 soniyadan keyin bir marta qayta uriniladi. Sahifalar kichik (ro'yxat 30, SKU qidiruv 20). Admin 15 soniyadan ko'p kutsa, "⏳" xabari "⏳ BITO javobini kutyapman..." deb yangilanadi. Mahsulot (SKU bo'yicha), narx, katalog sahifalari va mahsulotlar soni Redis'da 10 daqiqa keshlanadi (narxi yo'q mahsulot keshlanmaydi — narx keyin kiritilsa darhol ko'rinadi). Bir nechta SKU va narxlar parallel so'raladi. Random katalogni to'liq o'qimaydi — 1–2 ta tasodifiy sahifa oladi.
- **Telegram:** 10 soniyalik timeout; rasm yuboradigan metodlar (sendPhoto, albom, story) uchun 30 soniya (erta uzish dublikat postga olib kelishi mumkin).
- **Redis** ulanishi modul darajasida bir marta ochiladi va keyingi so'rovlarda qayta ishlatiladi.
- **sharp** (rasmni story uchun 1080×1920 ga moslash) faqat story yuborilayotganda yuklanadi.

## Testlar

`npm test` — narx funksiyasining unit testlari (`test/channel2.test.js`, `node --test`, qo'shimcha paketsiz).

## Eslatmalar

- Kanal postlarida "🛒 Buyurtma berish" tugmasi bor. Kanallarga albom yuborilmaydi: albom tugmani qo'llamaydi, shuning uchun har mahsulot alohida post. Postlar orasida 3 soniya (kanal daqiqasiga ~20 post qabul qiladi); Telegram 429 bersa `retry_after` qadar kutiladi, vaqt yetmasa navbatga qaytadi. Eski "Albom rejimi" / "Random ko'rinishi: Albom" sozlamalari endi e'tiborga olinmaydi.
- `vercel.json` funksiyalarga 300 soniya beradi (Fluid compute, yangi loyihalarda standart yoqilgan). Deploy shu sababli xato bersa, **Settings → Functions → Fluid Compute** ni yoqing.
- Webhook o'rnatilgandan keyin `getUpdates` ishlamaydi — biznes ulanishlar bazaga webhook orqali yoziladi, `/api/business-id` ularni bazadan qaytaradi.
