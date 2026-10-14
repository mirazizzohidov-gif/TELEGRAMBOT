import { handleUpdate } from '../lib/admin.js';
import { readBody } from '../lib/request.js';
import * as db from '../lib/store.js';
import { webhookSecretToken } from '../lib/webhook-secret.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }
  const token = webhookSecretToken();
  if (!token || req.headers['x-telegram-bot-api-secret-token'] !== token) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const update = readBody(req, res);
  if (!update) return;
  try {
    // Telegram re-sends an update if we answer slowly; handle each update_id once.
    if (update.update_id === undefined || (await db.firstUpdate(update.update_id))) {
      await handleUpdate(update);
    }
  } catch (err) {
    console.error('webhook', err);
  }
  // Always 200 so Telegram does not retry endlessly.
  return res.status(200).json({ ok: true });
}
