// "📈 Statistika": one place for every network the bot posts to.
//   activity — what the bot published per day (last 30 days, from the daily stat counters)
//   networks — live numbers: Instagram (followers, likes, reach, views), YouTube (subscribers, views),
//              Facebook (followers, reactions, comments, shares); cached 30 min ("🔄 Yangilash" refreshes)
//   top      — the best posts of the last 7 days across all networks
import { fbStatsData } from './facebook.js';
import { igCfg, igStats, SLOTS } from './ig.js';
import * as db from './store.js';
import { errText } from './util.js';
import { thStatsData } from './threads.js';
import { ytStatsData } from './youtube.js';

const CACHE = () => db.K.flag('socstats:live');
const DAYS = 30;

// daily counters -> per network
const NETS = {
  tg: { label: '✈️ Telegram', sum: (s) => Object.entries(s).reduce((a, [k, v]) => a + (/^(posted|\w+_posted|stories|discount_stories)$/.test(k) && !/^ch2_|^restock_auto_posted$/.test(k) ? v : 0), 0) },
  ig: { label: '📸 Instagram', sum: (s) => Object.entries(s).reduce((a, [k, v]) => a + (/^ig_(post|reel|story):/.test(k) ? v : 0), 0) },
  yt: { label: '▶️ YouTube', sum: (s) => s.yt_uploaded || 0 },
  fb: { label: '📘 Facebook', sum: (s) => (s.fb_post || 0) + (s.fb_reel || 0) + (s.fb_story || 0) },
  th: { label: '🧵 Threads', sum: (s) => (s.th_post || 0) + (s.th_reel || 0) },
  tt: { label: '🎵 TikTok', sum: (s) => s.tt_uploaded || 0 },
  pin: { label: '📌 Pinterest', sum: (s) => s.pin_created || 0 },
};

async function activity() {
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) days.push(db.today(Date.now() - i * 86400000));
  const stats = await Promise.all(days.map((d) => db.getStats(d).catch(() => ({}))));
  const rows = days.map((d, i) => {
    const s = stats[i];
    const row = { day: d };
    for (const [k, n] of Object.entries(NETS)) row[k] = n.sum(s);
    row.ig_detail = { post: 0, reel: 0, story: 0 };
    for (const [k, v] of Object.entries(s)) {
      const m = /^ig_(post|reel|story):/.exec(k);
      if (m) row.ig_detail[m[1]] += v;
    }
    row.orders = s.orders || 0;
    return row;
  });
  const total = (n) => Object.fromEntries(Object.keys(NETS).map((k) => [k, rows.slice(-n).reduce((a, r) => a + r[k], 0)]));
  return { rows, week: total(7), month: total(DAYS), today: rows[rows.length - 1] };
}

async function live() {
  const out = { at: Date.now(), ig: [], yt: null, fb: null, th: null, errors: {} };
  const s = await db.getSettings();
  await Promise.all([
    ...SLOTS.map(async (slot) => {
      if (!igCfg(s, slot).on) return;
      try {
        const r = await igStats(slot, { raw: true });
        if (r.ok && r.data) out.ig.push({ slot, ...r.data });
      } catch (e) {
        out.errors[`ig_${slot}`] = errText(e).slice(0, 200);
      }
    }),
    ytStatsData().then((d) => (out.yt = d), (e) => (out.errors.yt = errText(e).slice(0, 200))),
    fbStatsData().then((d) => (out.fb = d), (e) => (out.errors.fb = errText(e).slice(0, 200))),
    thStatsData().then((d) => (out.th = d), (e) => (out.errors.th = errText(e).slice(0, 200))),
  ]);
  out.ig.sort((a, b) => a.slot.localeCompare(b.slot));
  return out;
}

function topPosts(l) {
  const weekAgo = Date.now() - 7 * 86400000;
  const all = [];
  for (const a of l.ig) for (const m of a.items) all.push({ net: 'ig', acc: '@' + a.username, ...m, score: (m.views || m.reach || 0) + m.likes * 10 + m.comments * 20 });
  for (const v of l.yt?.items || []) all.push({ net: 'yt', acc: l.yt.name, ...v, score: v.views + v.likes * 10 + v.comments * 20 });
  for (const p of l.fb?.items || []) all.push({ net: 'fb', acc: l.fb.name, ...p, score: p.likes * 10 + p.comments * 20 + p.shares * 30 });
  for (const p of l.th?.items || []) all.push({ net: 'th', acc: l.th.name, ...p, score: (p.views || 0) + p.likes * 10 + p.comments * 20 + p.shares * 30 });
  return all.filter((x) => x.at >= weekAgo).sort((a, b) => b.score - a.score).slice(0, 10);
}

export async function socStats({ refresh = false } = {}) {
  const act = await activity();
  let l = !refresh ? await db.redis().get(CACHE()).catch(() => null) : null;
  if (!l) {
    l = await live();
    await db.redis().set(CACHE(), l, { ex: 30 * 60 }).catch(() => {});
  }
  const sumW = (items, f) => items.filter((x) => x.at >= Date.now() - 7 * 86400000).reduce((a, x) => a + (Number(x[f]) || 0), 0);
  const nets = [];
  for (const a of l.ig) nets.push({ net: 'ig', name: `@${a.username}`, sub: a.label, followers: a.followers, delta: a.delta, week: { posts: a.week.posts, views: a.week.views, reach: a.week.reach, likes: a.week.likes, comments: a.week.comments }, insights: a.insights, best: a.best });
  if (l.yt) nets.push({ net: 'yt', name: l.yt.name, followers: l.yt.subscribers, total_views: l.yt.views, week: { posts: l.yt.items.filter((x) => x.at >= Date.now() - 7 * 86400000).length, views: sumW(l.yt.items, 'views'), likes: sumW(l.yt.items, 'likes'), comments: sumW(l.yt.items, 'comments') }, private: l.yt.items.filter((x) => x.privacy === 'private').length });
  if (l.fb) nets.push({ net: 'fb', name: l.fb.name, followers: l.fb.followers, week: { posts: l.fb.items.filter((x) => x.at >= Date.now() - 7 * 86400000).length, likes: sumW(l.fb.items, 'likes'), comments: sumW(l.fb.items, 'comments'), shares: sumW(l.fb.items, 'shares') } });
  if (l.th) nets.push({ net: 'th', name: l.th.name, followers: l.th.followers, week: { posts: l.th.items.filter((x) => x.at >= Date.now() - 7 * 86400000).length, views: sumW(l.th.items, 'views'), likes: sumW(l.th.items, 'likes'), comments: sumW(l.th.items, 'comments'), shares: sumW(l.th.items, 'shares') } });
  return { ok: true, at: l.at, labels: Object.fromEntries(Object.entries(NETS).map(([k, n]) => [k, n.label])), activity: act, nets, top: topPosts(l), errors: l.errors };
}
