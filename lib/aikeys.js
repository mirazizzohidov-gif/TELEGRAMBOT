// AI API kalitlari dashboard'dan kiritiladi (Redis'da saqlanadi, Meta/TikTok tokenlari kabi).
// Vercel env'da kalit bo'lsa, u ustun turadi. Saqlangan kalit qayta ko'rsatilmaydi (faqat oxirgi 4 belgi).
import * as db from './store.js';

export const AI_KEY_ENVS = { gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const ENV0 = Object.fromEntries(Object.values(AI_KEY_ENVS).map((e) => [e, process.env[e] || '']));
const KEY = () => db.K.flag('ai:keys');
let loadedAt = 0;

// Saqlangan kalitlarni process.env'ga qo'yadi (env'da o'zi bor kalitga tegmaydi). 60 soniya keshlanadi.
export async function loadAiKeys({ force = false } = {}) {
  if (!db.hasRedis() || (!force && Date.now() - loadedAt < 60000)) return;
  loadedAt = Date.now();
  const saved = (await db.redis().get(KEY()).catch(() => null)) || {};
  for (const [id, env] of Object.entries(AI_KEY_ENVS)) {
    if (ENV0[env]) continue;
    if (saved[id]) process.env[env] = saved[id];
    else delete process.env[env];
  }
}

export async function aiKeysView() {
  const saved = db.hasRedis() ? (await db.redis().get(KEY()).catch(() => null)) || {} : {};
  const out = {};
  for (const [id, env] of Object.entries(AI_KEY_ENVS)) {
    if (ENV0[env]) out[id] = { source: 'env' };
    else if (saved[id]) out[id] = { source: 'dashboard', hint: `••••${String(saved[id]).slice(-4)}` };
    else out[id] = { source: 'none' };
  }
  return out;
}

// body: { gemini, groq, openrouter } — bo'sh yoki yo'q: o'zgarmaydi, "-": o'chirish
export async function setAiKeys(body = {}) {
  const saved = { ...((await db.redis().get(KEY()).catch(() => null)) || {}) };
  for (const id of Object.keys(AI_KEY_ENVS)) {
    const v = body[id] == null ? '' : String(body[id]).trim();
    if (!v) continue;
    if (v === '-') {
      delete saved[id];
      continue;
    }
    if (v.length < 20 || v.length > 300 || /\s/.test(v)) return { ok: false, message: `❌ ${id}: kalit noto'g'ri ko'rinadi (20–300 belgi, bo'shliqsiz)` };
    saved[id] = v;
  }
  await db.redis().set(KEY(), saved);
  await loadAiKeys({ force: true });
  return { ok: true, message: '💾 Kalitlar saqlandi', keys: await aiKeysView() };
}
