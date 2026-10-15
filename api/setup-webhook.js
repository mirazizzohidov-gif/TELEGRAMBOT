import { ADMIN_COMMANDS } from '../lib/admin.js';
import { GROUP_COMMANDS } from '../lib/stock.js';
import { getSettingsSafe } from '../lib/store.js';
import { checkSecret } from '../lib/request.js';
import { tg } from '../lib/telegram.js';
import { adminIds } from '../lib/util.js';
import { webhookSecretToken } from '../lib/webhook-secret.js';

// Admin-only command list and the "commands" menu button in each admin's chat.
// An admin who has never opened the bot gets "chat not found" — reported, not fatal.
async function setupAdminCommands() {
  const results = [];
  for (const id of adminIds()) {
    const scope = { type: 'chat', chat_id: id };
    try {
      await tg('setMyCommands', { commands: ADMIN_COMMANDS, scope });
      await tg('setChatMenuButton', { chat_id: id, menu_button: { type: 'commands' } });
      results.push({ admin: id, ok: true });
    } catch (err) {
      results.push({ admin: id, ok: false, error: err.message });
    }
  }
  return results;
}

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
      allowed_updates: ['message', 'callback_query', 'business_connection', 'my_chat_member'],
    });
    const commands = await setupAdminCommands();
    // Stock group commands (/tugagan, /kam, /bugun, /sku) in the selected group.
    const settings = await getSettingsSafe();
    if (settings.stock_group) {
      try {
        await tg('setMyCommands', { commands: GROUP_COMMANDS, scope: { type: 'chat', chat_id: settings.stock_group } });
        commands.push({ group: settings.stock_group, ok: true });
      } catch (err) {
        commands.push({ group: settings.stock_group, ok: false, error: err.message });
      }
    }
    const info = await tg('getWebhookInfo');
    return res.status(200).json({ ok: true, url, info, commands });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Telegram error', details: err.data || String(err) });
  }
}
