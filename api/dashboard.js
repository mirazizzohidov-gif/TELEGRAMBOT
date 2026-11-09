import { collectDashboard, dashboardKey, dashboardUrl } from '../lib/dashboard.js';
import { DASHBOARD_HTML, LOCKED_HTML, SENT_HTML } from '../lib/dashboard-page.js';
import { notifyAdmins } from '../lib/report.js';
import { hasRedis, once } from '../lib/store.js';
import { ROLES, addUser, can, listUsers, removeUser, renewUser, roleOf, setUserRole } from '../lib/access.js';
import { auditSetAlerts, auditSetGroup, auditTest, auditToggle, auditView } from '../lib/audit.js';
import { soldDelete, soldItems, soldPrepare } from '../lib/soldweb.js';
import { storyNow, storyQueueItems } from '../lib/storyweb.js';

// "📊 Dashboard": GET /api/dashboard?k=<key> -> the page; &format=json -> its data.
// GET /api/dashboard?send=1 -> the secret link goes to the admins in Telegram (at most once a minute).
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const isPost = req.method === 'POST';
  if (req.method !== 'GET' && !isPost) {
    return res.status(405).json({ ok: false, error: 'Use GET' });
  }
  if (!hasRedis()) {
    return res.status(500).json({ ok: false, error: 'Missing environment variables (Redis)' });
  }
  const html = (code, body) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(code).send(body);
  };
  if (req.query?.send === '1') {
    try {
      if (await once('dashboard:send', 60)) {
        const url = dashboardUrl(await dashboardKey());
        await notifyAdmins({
          text: `📊 <b>Dashboard</b>\n\nBot qilayotgan hamma ish: postlar, istoriyalar, navbatlar, grafiklar va xatolar.\n\n${url}\n\n🔒 Havola maxfiy — hech kimga bermang.`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      }
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    return html(200, SENT_HTML);
  }
  const k = String(req.query?.k || '');
  const json = req.query?.format === 'json';
  // 👑 admin (owner link) · 🛠 manage · 👁 view (lib/access.js)
  const me = await roleOf(k).catch(() => null);
  if (!me) {
    if (json || isPost) return res.status(401).json({ ok: false, error: 'Unauthorized', message: 'Havola eskirgan yoki o\'chirilgan' });
    return html(401, LOCKED_HTML);
  }
  const deny = () => res.status(403).json({ ok: false, error: 'Forbidden', message: "Sizda bu amal uchun huquq yo'q (faqat ko'rish)" });
  // POST actions: story_now (📋 Istoriya navbati), sold_prepare + sold_delete (❌ Tugaganlar, 2 steps)
  if (isPost) {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    const action = req.query?.action;
    const adminOnly = String(action || '').startsWith('user_');
    if (!can(me.role, adminOnly ? 'admin' : 'manage')) return deny();
    try {
      if (action === 'user_add') return res.status(200).json(await addUser(body?.name, body?.role));
      if (action === 'user_role') return res.status(200).json(await setUserRole(body?.id, body?.role));
      if (action === 'user_renew') return res.status(200).json(await renewUser(body?.id));
      if (action === 'user_remove') return res.status(200).json(await removeUser(body?.id));
      if (action === 'story_now') return res.status(200).json(await storyNow(body?.id));
      if (action === 'sold_prepare') return res.status(200).json(await soldPrepare(body?.pids));
      if (action === 'sold_delete') return res.status(200).json(await soldDelete(body?.token, body?.confirm));
      if (action === 'audit_group') return res.status(200).json(await auditSetGroup(body?.id || null));
      if (action === 'audit_toggle') return res.status(200).json(await auditToggle(String(body?.type || ''), Boolean(body?.on)));
      if (action === 'audit_test') return res.status(200).json(await auditTest());
      if (action === 'audit_alerts') return res.status(200).json(await auditSetAlerts(body?.cfg || {}));
      return res.status(400).json({ ok: false, error: 'Unknown action' });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
  if (json && req.query?.part === 'me') {
    return res.status(200).json({ ok: true, role: me.role, name: me.name, role_title: ROLES[me.role] });
  }
  if (json && req.query?.part === 'users') {
    if (!can(me.role, 'admin')) return deny();
    return res.status(200).json({ ok: true, users: await listUsers(), roles: ROLES });
  }
  if (json && req.query?.part === 'audit') {
    try {
      return res.status(200).json({ ok: true, ...(await auditView()) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (json && req.query?.part === 'sold') {
    try {
      return res.status(200).json({ ok: true, ...(await soldItems()) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (json && req.query?.part === 'story') {
    try {
      return res.status(200).json({ ok: true, ...(await storyQueueItems()) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (json) {
    try {
      return res.status(200).json({ ok: true, ...(await collectDashboard()) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  return html(200, DASHBOARD_HTML);
}
