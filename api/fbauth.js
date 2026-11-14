// "📘 Facebook sahifa" connection (lib/facebook.js):
//   GET /api/fbauth?k=<admin dashboard key>  -> Google's consent page
//   GET /api/fbauth?code=…&state=…          -> Google comes back here: the channel is saved
import { roleOf } from '../lib/access.js';
import { fbAuthUrl, fbFinishAuth } from '../lib/facebook.js';
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
      const r = await fbFinishAuth(String(req.query.code), String(req.query.state || ''));
      return res.status(200).send(page('✅ Facebook ulandi', `Sahifa: <b>${esc(r.page)}</b>${r.pages.length > 1 ? ` (jami ${r.pages.length} ta sahifa — dashboardda boshqasini tanlash mumkin)` : ''}. Endi Instagram'ga chiqqanlar shu sahifaga ham chiqadi. Bu oynani yopib, dashboardga qayting.`));
    }
    const me = await roleOf(String(req.query?.k || '')).catch(() => null);
    if (me?.role !== 'admin') return res.status(403).send(page('🔒 Ruxsat yo\'q', 'Facebook\'ni faqat admin ulay oladi.'));
    res.statusCode = 302;
    res.setHeader('Location', await fbAuthUrl());
    return res.end();
  } catch (e) {
    return res.status(500).send(page('❌ Xato', esc(errText(e))));
  }
}
