// "▶️ YouTube Shorts" connection (lib/youtube.js):
//   GET /api/ytauth?k=<admin dashboard key>  -> Google's consent page
//   GET /api/ytauth?code=…&state=…          -> Google comes back here: the channel is saved
import { roleOf } from '../lib/access.js';
import { ytAuthUrl, ytFinishAuth } from '../lib/youtube.js';
import { errText } from '../lib/util.js';

const page = (title, text) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:16px system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px"><h2>${title}</h2><p>${text}</p></body>`;
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    if (req.query?.code || req.query?.error) {
      if (req.query.error) return res.status(400).send(page('❌ Ulanmadi', `Google: ${esc(req.query.error)}`));
      const r = await ytFinishAuth(String(req.query.code), String(req.query.state || ''));
      return res.status(200).send(page('✅ YouTube ulandi', `Kanal: <b>${esc(r.channel)}</b>. Endi Instagram'ga chiqqan har bir Reels shu kanalga Shorts bo'lib ham joylanadi. Bu oynani yopib, dashboardga qayting.`));
    }
    const me = await roleOf(String(req.query?.k || '')).catch(() => null);
    if (me?.role !== 'admin') return res.status(403).send(page('🔒 Ruxsat yo\'q', 'YouTube\'ni faqat admin ulay oladi.'));
    res.statusCode = 302;
    res.setHeader('Location', await ytAuthUrl());
    return res.end();
  } catch (e) {
    return res.status(500).send(page('❌ Xato', esc(errText(e))));
  }
}
