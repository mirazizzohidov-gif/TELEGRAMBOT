// "🎬 Video joylash": the browser uploads the video straight to Vercel Blob (no size limit of a function
// body, original quality). This route only hands out a short upload token to a dashboard user
// (manage role, "🎬 Video joylash" tab) and answers Blob's "upload finished" callback.
import { handleUpload } from '@vercel/blob/client';
import { can, canTab, roleOf } from '../lib/access.js';
import { VPOST_MAX } from '../lib/vpost.js';
import { selfHosted, streamToMedia } from '../lib/media.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // o'z serverimiz: brauzer videoni PUT bilan to'g'ridan-to'g'ri yuboradi, diskka yoziladi
  if (req.method === 'PUT') {
    if (!selfHosted()) return res.status(405).json({ ok: false, error: 'Use POST' });
    const me = await roleOf(String(req.query?.k || '')).catch(() => null);
    if (!me || !can(me.role, 'manage') || !canTab(me, 'vpost')) return res.status(401).json({ error: "Ruxsat yo'q" });
    const type = String(req.headers['content-type'] || '');
    if (!/^video\//.test(type)) return res.status(400).json({ error: 'Faqat video' });
    const base = String(req.query?.name || 'video.mp4').replace(/[^\w.-]+/g, '_').slice(-80) || 'video.mp4';
    const rel = `vpost/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}-${base}`;
    try {
      const out = await streamToMedia(req, rel, VPOST_MAX);
      return res.status(200).json({ ok: true, url: out.url, size: out.size });
    } catch (e) {
      return res.status(e.message === 'too large' ? 413 : 400).json({ error: e.message === 'too large' ? 'Video 500 MB dan katta' : String(e.message || e) });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (body?.type !== 'blob.upload-completed') {
    const me = await roleOf(String(req.query?.k || '')).catch(() => null);
    if (!me || !can(me.role, 'manage') || !canTab(me, 'vpost')) return res.status(401).json({ error: 'Ruxsat yo\'q' });
  }
  try {
    const out = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm'],
        maximumSizeInBytes: VPOST_MAX,
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {},
    });
    return res.status(200).json(out);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
