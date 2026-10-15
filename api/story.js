import { resolveProduct } from '../lib/bito.js';
import { buildCaption, buildPostCaption } from '../lib/caption.js';
import { checkSecret, readBody } from '../lib/request.js';
import { getSettingsSafe, listBiz, storyProfiles } from '../lib/store.js';
import { postStoryToAll } from '../lib/poster.js';
import { ACTIVE_PERIODS } from '../lib/story.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }
  const { BOT_TOKEN, SECRET } = process.env;
  const settings = await getSettingsSafe();
  const profiles = storyProfiles(settings, await listBiz().catch(() => []));
  if (!BOT_TOKEN || !SECRET || !profiles.length) {
    return res.status(500).json({ ok: false, error: 'Missing environment variables' });
  }
  if (!checkSecret(req, res)) return;
  const body = readBody(req, res);
  if (!body) return;
  const activePeriod = body.active_period === undefined ? 86400 : Number(body.active_period);
  if (!ACTIVE_PERIODS.includes(activePeriod)) {
    return res.status(400).json({ ok: false, error: `active_period must be one of ${ACTIVE_PERIODS.join(', ')}` });
  }
  let product;
  try {
    product = await resolveProduct(body);
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Every selected business profile through the shared story path (one retry per profile, logged).
  const r = await postStoryToAll({ sku: product.sku || body.sku || 'api', name: product.name, image_url: product.image_url }, settings, {
    profiles,
    activePeriod,
    ignoreLimit: true,
    noQueue: true,
    deadline: Date.now() + 240000,
    caption: product.discount
      ? buildPostCaption({ name: product.name, ...product.discount }, settings.phone)
      : esc(buildCaption(product.name, product.price, settings.phone)),
  });
  const results = r.profiles.map((p) => (p.ok ? { profile: p.label, ok: true, story_id: p.story_id } : { profile: p.label, ok: false, error: p.error }));
  const first = results.find((x) => x.ok);
  if (!first) {
    return res.status(502).json({ ok: false, error: 'Telegram error', results, product });
  }
  return res.status(200).json({ ok: true, story_id: first.story_id, results, product });
}
