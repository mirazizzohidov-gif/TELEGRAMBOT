import { clock, fetchWithTimeout } from './util.js';

// Media methods make Telegram download/upload files and can take longer; aborting them early could
// lead to duplicates (Telegram finishes, we retry), so they get a longer timeout.
const SLOW_METHODS = new Set(['sendVideo', 'sendMediaGroup', 'postStory', 'sendPhoto', 'editMessageMedia']);

export class TgError extends Error {
  constructor(method, data) {
    super(`${method}: ${data.description || 'Telegram error'}`);
    this.code = data.error_code;
    this.retryAfter = data.parameters?.retry_after;
    this.data = data;
  }
}

// Optional observer of successful calls (the stock report remembers the messages it sends).
let afterOk = null;
export const onTgResult = (fn) => {
  afterOk = fn;
};

// Calls a Bot API method. On 429 waits retry_after and retries (if it fits before `deadline`).
const moved = new Map(); // eski chat id → yangi (superguruhga aylangan guruhlar), shu jarayon uchun

export async function tg(method, payload = {}, { deadline, retries = 3 } = {}, migrated = false) {
  if (!(payload instanceof FormData) && payload.chat_id != null && moved.has(String(payload.chat_id))) payload = { ...payload, chat_id: moved.get(String(payload.chat_id)) };
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`;
  for (let attempt = 0; ; attempt++) {
    const init =
      payload instanceof FormData
        ? { method: 'POST', body: payload }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    const r = await fetchWithTimeout(url, init, SLOW_METHODS.has(method) ? 30000 : 10000);
    const data = await r.json().catch(() => ({ ok: false, error_code: r.status, description: `HTTP ${r.status}` }));
    if (data.ok) {
      if (afterOk) await Promise.resolve(afterOk(method, payload, data.result)).catch(() => {});
      return data.result;
    }
    const waitMs = data.error_code === 429 ? ((data.parameters?.retry_after || 1) + 0.5) * 1000 : 0;
    if (waitMs && attempt < retries && (!deadline || Date.now() + waitMs < deadline)) {
      await clock.sleep(waitMs);
      continue;
    }
    // guruh superguruhga aylangan (masalan «Mavzular» yoqilgach): yangi id saqlanadi va chaqiruv shu id bilan takrorlanadi
    const to = data.parameters?.migrate_to_chat_id;
    if (to && !migrated && !(payload instanceof FormData) && payload.chat_id != null) {
      moved.set(String(payload.chat_id), String(to));
      await import('./groupmigrate.js').then((m) => m.migrateGroup(payload.chat_id, to)).catch(() => {});
      return tg(method, { ...payload, chat_id: String(to) }, { deadline, retries }, true);
    }
    throw new TgError(method, data);
  }
}
