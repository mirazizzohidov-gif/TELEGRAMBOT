// "🎬 Video joylash": the browser uploads the video straight to Vercel Blob (no size limit of a function
// body, original quality). This route only hands out a short upload token to a dashboard user
// (manage role, "🎬 Video joylash" tab) and answers Blob's "upload finished" callback.
import { handleUpload } from '@vercel/blob/client';
import { can, canTab, roleOf } from '../lib/access.js';
import { VPOST_MAX } from '../lib/vpost.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
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
