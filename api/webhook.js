import { handleUpdate } from '../lib/admin.js';
import { runInBackground } from '../lib/background.js';
import { readBody } from '../lib/request.js';
import * as db from '../lib/store.js';
import { webhookSecretToken } from '../lib/webhook-secret.js';

// Answers Telegram with 200 right away and does the work in the background (waitUntil). A slow
// answer would make Telegram re-send the update and the action would run twice.
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
    // Each update_id is handled once (kept 10 minutes).
    if (update.update_id === undefined || (await db.firstUpdate(update.update_id))) {
      const started = Date.now();
      runInBackground(
        handleUpdate(update).then(() => console.log(`update ${update.update_id} handled in ${Date.now() - started} ms`)),
      );
    } else {
      console.log(`update ${update.update_id} is a duplicate, skipped`);
    }
  } catch (err) {
    console.error('webhook', err);
  }
  return res.status(200).json({ ok: true });
}
