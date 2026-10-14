import sharp from 'sharp';
import { resolveProduct } from '../lib/bito.js';
import { buildCaption } from '../lib/caption.js';
import { checkSecret, readBody } from '../lib/request.js';

const ACTIVE_PERIODS = [21600, 43200, 86400, 172800];
const MAX_BYTES = 10 * 1024 * 1024;

async function toStoryJpeg(input) {
const base = sharp(input).rotate().resize(1080, 1920, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' });
for (const quality of [90, 80, 70, 60, 50]) {
const out = await base.clone().jpeg({ quality }).toBuffer();
if (out.length < MAX_BYTES) {
return out;
}
}
throw new Error('Image is larger than 10MB after compression');
}

export default async function handler(req, res) {
if (req.method !== 'POST') {
return res.status(405).json({ ok: false, error: 'Use POST' });
}
const { BOT_TOKEN, SECRET, BUSINESS_CONNECTION_ID } = process.env;
if (!BOT_TOKEN || !SECRET || !BUSINESS_CONNECTION_ID) {
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
const imgRes = await fetch(product.image_url);
if (!imgRes.ok) {
return res.status(502).json({ ok: false, error: `Image download failed: HTTP ${imgRes.status}` });
}
photo = await toStoryJpeg(Buffer.from(await imgRes.arrayBuffer()));
} catch (err) {
return res.status(502).json({ ok: false, error: 'Image processing failed', details: String(err) });
}
const form = new FormData();
form.append('business_connection_id', BUSINESS_CONNECTION_ID);
form.append('content', JSON.stringify({ type: 'photo', photo: 'attach://story_photo' }));
form.append('story_photo', new Blob([photo], { type: 'image/jpeg' }), 'story.jpg');
form.append('active_period', String(activePeriod));
form.append('caption', buildCaption(product.name, product.price));
try {
const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/postStory`, { method: 'POST', body: form });
const data = await tgRes.json();
if (!data.ok) {
return res.status(502).json({ ok: false, error: 'Telegram error', details: data });
}
return res.status(200).json({ ok: true, story_id: data.result.id, product });
} catch (err) {
return res.status(500).json({ ok: false, error: String(err) });
}
}
