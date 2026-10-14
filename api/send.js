import { resolveProduct } from '../lib/bito.js';
import { buildCaption } from '../lib/caption.js';
import { orderKeyboard } from '../lib/poster.js';
import { checkSecret, readBody } from '../lib/request.js';
import { getSettingsSafe } from '../lib/store.js';
import { tg } from '../lib/telegram.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }
  const { BOT_TOKEN, CHANNEL_ID, SECRET, PROTECT_CONTENT } = process.env;
  if (!BOT_TOKEN || !CHANNEL_ID || !SECRET) {
    return res.status(500).json({ ok: false, error: 'Missing environment variables' });
  }
  if (!checkSecret(req, res)) return;
  const body = readBody(req, res);
  if (!body) return;
  let product;
  try {
    product = await resolveProduct(body);
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
  const settings = await getSettingsSafe();
  try {
    const result = await tg('sendPhoto', {
      chat_id: CHANNEL_ID,
      photo: product.image_url,
      caption: buildCaption(product.name, product.price, settings.phone),
      reply_markup: orderKeyboard(settings.order_url),
      protect_content: PROTECT_CONTENT !== 'false',
    });
    return res.status(200).json({ ok: true, message_id: result.message_id, product });
  } catch (err) {
    if (err.data) {
      return res.status(502).json({ ok: false, error: 'Telegram error', details: err.data });
    }
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
