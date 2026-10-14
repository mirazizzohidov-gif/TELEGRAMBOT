import { tg } from './telegram.js';
import { fetchWithTimeout } from './util.js';

// sharp (native) is loaded only when a story image is actually built, not on every cold start.
let sharpLib = null;
const loadSharp = async () => (sharpLib ||= (await import('sharp')).default);

export const ACTIVE_PERIODS = [21600, 43200, 86400, 172800];
const MAX_BYTES = 10 * 1024 * 1024;

export async function toStoryJpeg(input) {
  const sharp = await loadSharp();
  const base = sharp(input)
    .rotate()
    .resize(1080, 1920, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' });
  for (const quality of [90, 80, 70, 60, 50]) {
    const out = await base.clone().jpeg({ quality }).toBuffer();
    if (out.length < MAX_BYTES) {
      return out;
    }
  }
  throw new Error('Image is larger than 10MB after compression');
}

export async function downloadImage(url) {
  const r = await fetchWithTimeout(url, {}, 10000);
  if (!r.ok) {
    throw new Error(`Image download failed: HTTP ${r.status}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

// Posts a photo story via Telegram Business. Returns the Story object.
export async function postStory({ businessConnectionId, photo, caption, parseMode, activePeriod = 86400, deadline }) {
  const form = new FormData();
  form.append('business_connection_id', businessConnectionId);
  form.append('content', JSON.stringify({ type: 'photo', photo: 'attach://story_photo' }));
  form.append('story_photo', new Blob([photo], { type: 'image/jpeg' }), 'story.jpg');
  form.append('active_period', String(activePeriod));
  form.append('caption', caption);
  if (parseMode) {
    form.append('parse_mode', parseMode);
  }
  return tg('postStory', form, { deadline });
}

export async function postProductStory({ businessConnectionId, imageUrl, caption, parseMode, activePeriod, deadline }) {
  const photo = await toStoryJpeg(await downloadImage(imageUrl));
  return postStory({ businessConnectionId, photo, caption, parseMode, activePeriod, deadline });
}
