import { resolveProduct } from '../lib/bito.js';
import { buildCaption } from '../lib/caption.js';
import { checkSecret, readBody } from '../lib/request.js';
import { getSettingsSafe, listBiz, storyProfiles } from '../lib/store.js';
import { ACTIVE_PERIODS, downloadImage, postStory, toStoryJpeg } from '../lib/story.js';

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
  let photo;
  try {
    photo = await toStoryJpeg(await downloadImage(product.image_url));
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Image processing failed', details: String(err) });
  }
  // Posted to every selected business profile; story_id is the first successful one.
  const results = [];
  for (const p of profiles) {
    try {
      const story = await postStory({
        businessConnectionId: p.id,
        photo,
        caption: buildCaption(product.name, product.price, settings.phone),
        activePeriod,
      });
      results.push({ profile: p.label, ok: true, story_id: story.id });
    } catch (err) {
      console.error(`story failed: profile=${p.label} (${p.id}): ${err.data?.description || err.message}`);
      results.push({ profile: p.label, ok: false, error: err.data?.description || String(err) });
    }
  }
  const first = results.find((r) => r.ok);
  if (!first) {
    return res.status(502).json({ ok: false, error: 'Telegram error', results, product });
  }
  return res.status(200).json({ ok: true, story_id: first.story_id, results, product });
}
