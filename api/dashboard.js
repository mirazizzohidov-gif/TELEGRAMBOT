import { collectDashboard, dashboardKey, dashboardUrl } from '../lib/dashboard.js';
import { DASHBOARD_HTML, LOCKED_HTML, SENT_HTML } from '../lib/dashboard-page.js';
import { notifyAdmins } from '../lib/report.js';
import { hasRedis, once } from '../lib/store.js';
import { ROLES, TABS, addUser, can, canTab, listUsers, removeUser, renewUser, roleOf, setUserRole, setUserTabs } from '../lib/access.js';
import { auditSetAlerts, auditSetGroup, auditTest, auditToggle, auditView } from '../lib/audit.js';
import { soldDelete, soldItems, soldPrepare } from '../lib/soldweb.js';
import { whState, whSync } from '../lib/whstock.js';
import { startWhMove, whMoveSetCfg, whMoveView } from '../lib/whmove.js';
import { fbClear, fbDisconnect, fbRemoveKeys, fbSetCfg, fbSetKeys, fbView } from '../lib/facebook.js';
import { pinClear, pinDisconnect, pinRemoveKeys, pinSetCfg, pinSetKeys, pinView } from '../lib/pinterest.js';
import { ttClear, ttDisconnect, ttRemoveKeys, ttSetCfg, ttSetKeys, ttView } from '../lib/tiktok.js';
import { ytClear, ytDisconnect, ytRemoveKeys, ytSetCfg, ytSetKeys, ytView } from '../lib/youtube.js';
import { getSettingsSafe } from '../lib/store.js';
import { storyNow, storyQueueItems } from '../lib/storyweb.js';
import { igCarouselNow, igQueue, igQueueAction, igStats, igCheckAccount, igClearQueue, igManual, igMusicAdd, igMusicDel, igPreview, igRemoveToken, igSearch, igSetCfg, igSetToken, igView } from '../lib/ig.js';

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
  const denyTab = () => res.status(403).json({ ok: false, error: 'Forbidden', message: "Bu bo'limga ruxsatingiz yo'q" });
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
    const adminOnly = String(action || '').startsWith('user_') || action === 'ig_token' || action === 'ig_remove' || action === 'yt_disconnect' || action === 'yt_keys' || action === 'yt_keys_del' || action === 'fb_keys' || action === 'fb_keys_del' || action === 'fb_disconnect' || action === 'tt_keys' || action === 'tt_keys_del' || action === 'tt_disconnect' || action === 'pin_keys' || action === 'pin_keys_del' || action === 'pin_disconnect';
    if (!can(me.role, adminOnly ? 'admin' : 'manage')) return deny();
    const a = String(action || '');
    const tab = a === 'story_now' ? 'story' : a.startsWith('sold_') || a.startsWith('wh_move') ? 'sold' : a.startsWith('audit_') ? 'audit' : a.startsWith('ig_') ? 'ig' : a.startsWith('yt_') ? 'yt' : a.startsWith('fb_') ? 'fb' : a.startsWith('tt_') ? 'tt' : a.startsWith('pin_') ? 'pin' : null;
    if (tab && !canTab(me, tab)) return denyTab();
    try {
      if (action === 'user_add') return res.status(200).json(await addUser(body?.name, body?.role, body?.tabs));
      if (action === 'user_tabs') return res.status(200).json(await setUserTabs(body?.id, body?.tabs));
      if (action === 'user_role') return res.status(200).json(await setUserRole(body?.id, body?.role));
      if (action === 'user_renew') return res.status(200).json(await renewUser(body?.id));
      if (action === 'user_remove') return res.status(200).json(await removeUser(body?.id));
      if (action === 'story_now') return res.status(200).json(await storyNow(body?.id));
      if (action === 'sold_prepare') return res.status(200).json(await soldPrepare(body?.pids));
      if (action === 'wh_move_send') return res.status(200).json(await startWhMove(await getSettingsSafe(), { deadline: Date.now() + 50000 }));
      if (action === 'wh_move_cfg') return res.status(200).json(await whMoveSetCfg(body || {}));
      if (action === 'sold_delete') return res.status(200).json(await soldDelete(body?.token, body?.confirm));
      if (action === 'audit_group') return res.status(200).json(await auditSetGroup(body?.id || null));
      if (action === 'audit_toggle') return res.status(200).json(await auditToggle(String(body?.type || ''), Boolean(body?.on)));
      if (action === 'audit_test') return res.status(200).json(await auditTest());
      if (action === 'audit_alerts') return res.status(200).json(await auditSetAlerts(body?.cfg || {}));
      if (action === 'ig_token') return res.status(200).json(await igSetToken(String(body?.slot || ''), body?.token, body?.ig_id));
      if (action === 'ig_remove') return res.status(200).json(await igRemoveToken(String(body?.slot || '')));
      if (action === 'ig_cfg') return res.status(200).json(await igSetCfg(String(body?.slot || ''), body?.cfg || {}));
      if (action === 'ig_check') return res.status(200).json(await igCheckAccount(String(body?.slot || '')));
      if (action === 'ig_search') return res.status(200).json(await igSearch(body?.q));
      if (action === 'ig_manual') return res.status(200).json(await igManual(body || {}));
      if (action === 'ig_preview') return res.status(200).json(await igPreview(body || {}));
      if (action === 'ig_carousel_now') return res.status(200).json(await igCarouselNow(String(body?.slot || '')));
      if (action === 'ig_music_add') return res.status(200).json(await igMusicAdd(body?.name, body?.data));
      if (action === 'ig_music_del') return res.status(200).json(await igMusicDel(body?.id));
      if (action === 'ig_queue_op') return res.status(200).json(await igQueueAction(body?.id, String(body?.op || '')));
      if (action === 'ig_stats') return res.status(200).json(await igStats(String(body?.slot || '')).catch((e) => ({ ok: false, message: e.message })));
      if (action === 'fb_cfg') return res.status(200).json(await fbSetCfg(body || {}));
      if (action === 'fb_clear') return res.status(200).json(await fbClear());
      if (action === 'fb_keys') return res.status(200).json(await fbSetKeys(body || {}));
      if (action === 'fb_keys_del') return res.status(200).json(await fbRemoveKeys());
      if (action === 'fb_disconnect') return res.status(200).json(await fbDisconnect());
      if (action === 'pin_cfg') return res.status(200).json(await pinSetCfg(body || {}));
      if (action === 'pin_clear') return res.status(200).json(await pinClear());
      if (action === 'pin_keys') return res.status(200).json(await pinSetKeys(body || {}));
      if (action === 'pin_keys_del') return res.status(200).json(await pinRemoveKeys());
      if (action === 'pin_disconnect') return res.status(200).json(await pinDisconnect());
      if (action === 'tt_cfg') return res.status(200).json(await ttSetCfg(body || {}));
      if (action === 'tt_clear') return res.status(200).json(await ttClear());
      if (action === 'tt_keys') return res.status(200).json(await ttSetKeys(body || {}));
      if (action === 'tt_keys_del') return res.status(200).json(await ttRemoveKeys());
      if (action === 'tt_disconnect') return res.status(200).json(await ttDisconnect());
      if (action === 'yt_cfg') return res.status(200).json(await ytSetCfg(body || {}));
      if (action === 'yt_clear') return res.status(200).json(await ytClear());
      if (action === 'yt_keys') return res.status(200).json(await ytSetKeys(body || {}));
      if (action === 'yt_keys_del') return res.status(200).json(await ytRemoveKeys());
      if (action === 'yt_disconnect') return res.status(200).json(await ytDisconnect());
      if (action === 'ig_clear') return res.status(200).json(await igClearQueue(String(body?.slot || '')));
      return res.status(400).json({ ok: false, error: 'Unknown action' });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
  if (json && req.query?.part === 'me') {
    return res.status(200).json({ ok: true, role: me.role, name: me.name, role_title: ROLES[me.role], tabs: Object.keys(TABS).filter((t) => canTab(me, t)) });
  }
  if (json) {
    const part = String(req.query?.part || '');
    const tab = { '': 'report', story: 'story', sold: 'sold', whmove: 'sold', audit: 'audit', ig: 'ig', igqueue: 'ig', yt: 'yt', fb: 'fb', tt: 'tt', pin: 'pin' }[part];
    if (tab && !canTab(me, tab)) return denyTab();
  }
  if (json && req.query?.part === 'users') {
    if (!can(me.role, 'admin')) return deny();
    return res.status(200).json({ ok: true, users: await listUsers(), roles: ROLES, tabs: TABS });
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
      // per-warehouse table not read fully yet: read some more now (the tick reads the rest)
      if (!(await whState().catch(() => ({}))).last_full_at) await whSync({ deadline: Date.now() + 20000 }).catch(() => null);
      return res.status(200).json({ ok: true, ...(await soldItems(String(req.query?.wh || 'shop'))) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (json && req.query?.part === 'whmove') {
    try {
      return res.status(200).json(await whMoveView(await getSettingsSafe()));
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (json && req.query?.part === 'fb') {
    try {
      return res.status(200).json(await fbView(await getSettingsSafe()));
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (json && req.query?.part === 'pin') {
    try {
      return res.status(200).json(await pinView(await getSettingsSafe()));
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (json && req.query?.part === 'tt') {
    try {
      return res.status(200).json(await ttView(await getSettingsSafe()));
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (json && req.query?.part === 'yt') {
    try {
      return res.status(200).json(await ytView(await getSettingsSafe()));
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (json && req.query?.part === 'igqueue') {
    try {
      return res.status(200).json(await igQueue());
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (json && req.query?.part === 'ig') {
    try {
      return res.status(200).json({ ok: true, ...(await igView()) });
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
