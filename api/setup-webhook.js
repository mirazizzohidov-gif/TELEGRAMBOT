import { checkSecret } from '../lib/request.js';
import { tg } from '../lib/telegram.js';
import { webhookSecretToken } from '../lib/webhook-secret.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET or POST' });
  }
  if (!process.env.BOT_TOKEN || !process.env.SECRET) {
    return res.status(500).json({ ok: false, error: 'Missing environment variables' });
  }
  if (!checkSecret(req, res)) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `https://${host}/api/webhook`;
  try {
    await tg('setWebhook', {
      url,
      secret_token: webhookSecretToken(),
      allowed_updates: ['message', 'callback_query', 'business_connection'],
    });
    const info = await tg('getWebhookInfo');
    return res.status(200).json({ ok: true, url, info });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Telegram error', details: err.data || String(err) });
  }
}
