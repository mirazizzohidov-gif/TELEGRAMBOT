import { clock } from './util.js';

export class TgError extends Error {
  constructor(method, data) {
    super(`${method}: ${data.description || 'Telegram error'}`);
    this.code = data.error_code;
    this.retryAfter = data.parameters?.retry_after;
    this.data = data;
  }
}

// Calls a Bot API method. On 429 waits retry_after and retries (if it fits before `deadline`).
export async function tg(method, payload = {}, { deadline, retries = 3 } = {}) {
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`;
  for (let attempt = 0; ; attempt++) {
    const init =
      payload instanceof FormData
        ? { method: 'POST', body: payload }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    const r = await fetch(url, init);
    const data = await r.json().catch(() => ({ ok: false, error_code: r.status, description: `HTTP ${r.status}` }));
    if (data.ok) {
      return data.result;
    }
    const waitMs = data.error_code === 429 ? ((data.parameters?.retry_after || 1) + 0.5) * 1000 : 0;
    if (waitMs && attempt < retries && (!deadline || Date.now() + waitMs < deadline)) {
      await clock.sleep(waitMs);
      continue;
    }
    throw new TgError(method, data);
  }
}
