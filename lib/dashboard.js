// "📊 Dashboard": a web page (api/dashboard.js) with everything the bot does — today's posts and
// stories, the queues, 30 days of numbers, the health of the 15-minute job, the story profiles and
// the last errors. Read-only: it never posts or changes anything.
//
// Access: a secret link from the admin panel ("📊 Dashboard"). The key lives in Redis; "♻️ Yangi havola"
// makes a new one and the old link stops working.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ch2QueueLength } from './channel2.js';
import { pacedSummary, paceOn, windowOf, fmtHHMM } from './pace.js';
import { storyPeriod } from './poster.js';
import { restockQueueLength } from './restock.js';
import * as db from './store.js';
import { postSales } from './postsales.js';

const KEY = () => `${db.K.flag('dashboard')}:key`;
const HEALTH = () => `${db.K.flag('health')}:state`; // lib/health.js
const DAY_MS = 86400000;
const DAYS = 30;

// ---- access ----

export async function dashboardKey({ rotate = false } = {}) {
  let k = rotate ? null : await db.redis().get(KEY());
  if (!k) {
    // a letter first: Redis clients turn an all-digit value back into a number
    k = `k${randomBytes(16).toString('hex')}`;
    await db.redis().set(KEY(), k);
  }
  return String(k);
}

export async function checkDashboardKey(k) {
  if (typeof k !== 'string' || !k) return false;
  const real = await db.redis().get(KEY());
  if (!real) return false;
  const a = Buffer.from(String(real));
  const b = Buffer.from(k);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function dashboardUrl(k) {
  const host = process.env.DASHBOARD_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
  return `https://${host}/api/dashboard?k=${encodeURIComponent(k)}`;
}

// ---- data ----

const num = (v) => Number(v) || 0;
const sumPrefix = (st, prefix) =>
  Object.entries(st || {}).reduce((n, [k, v]) => (k.startsWith(prefix) ? n + num(v) : n), 0);

// one day of numbers (stats hash fields, lib/store.js incrStat)
function dayRow(day, st) {
  return {
    day,
    posted: num(st.posted), // 🆕 new products -> channel
    discount: num(st.discount_posted),
    restock: num(st.restock_posted) + num(st.restock_auto_posted),
    random: num(st.random_album),
    ch2: num(st.ch2_posted),
    failed: num(st.failed),
    stories: sumPrefix(st, 'stories:'),
    discount_stories: sumPrefix(st, 'discount_stories:'),
  };
}

async function hlen(key) {
  const r = db.redis();
  if (typeof r.hlen === 'function') return num(await r.hlen(key));
  return Object.keys((await r.hgetall(key)) || {}).length;
}

const errorLine = (e) => {
  if (e == null) return null;
  if (typeof e === 'string') return { text: e };
  return { at: e.at || e.time || null, text: e.text || e.error || e.message || JSON.stringify(e) };
};

export async function collectDashboard(now = Date.now()) {
  const problems = [];
  const safe = async (name, fn, fallback) => {
    try {
      return await fn();
    } catch (e) {
      problems.push(`${name}: ${e?.message || e}`);
      return fallback;
    }
  };

  const s = await db.getSettings();
  const today = db.today(now);
  const days = Array.from({ length: DAYS }, (_, i) => db.today(now - (DAYS - 1 - i) * DAY_MS));
  const [stats, biz, storyLast, health, queue, storyQ, restockQ, ch2Q, errors] = await Promise.all([
    Promise.all(days.map((d) => safe(`stats ${d}`, () => db.getStats(d), {}))),
    safe('profiles', () => db.listBiz(), []),
    safe('story last', () => db.getStoryLast(), {}),
    safe('health', async () => (await db.redis().hgetall(HEALTH())) || {}, {}),
    safe('queue', () => db.queueLength(), 0),
    safe('story queue', () => pacedSummary(s, now), null),
    safe('restock queue', () => restockQueueLength(), 0),
    safe('2nd channel queue', () => ch2QueueLength(), 0),
    safe('errors', async () => ((await db.redis().lrange(db.K.errors, 0, 19)) || []).map(errorLine).filter(Boolean), []),
  ]);
  const st = stats[stats.length - 1] || {};

  const profiles = db.storyProfiles(s, biz).map((p) => {
    const last = storyLast[p.id] || null;
    return {
      label: p.label,
      stories: num(st[`stories:${p.id}`]),
      discount_stories: num(st[`discount_stories:${p.id}`]),
      limit: db.storyDailyLimit(s),
      discount_limit: db.discountStoryLimit(s),
      fail_streak: num(health[`story:${p.id}`]),
      last: last && { at: last.at || null, sku: last.sku || null, ok: Boolean(last.ok), queued: Boolean(last.queued), error: last.error || null },
    };
  });

  const extras = await Promise.all([
    safe('orders', async () => Math.max(0, (await hlen(db.K.orders)) - 1), null), // field "seq" is not an order
    safe('stock out', () => hlen(db.K.stockOut), null),
    safe('stock low', () => hlen(db.K.stockLow), null),
    safe('waitlist', () => hlen(db.K.waitIndex), null),
    safe('groups', async () => (await db.listGroups()).length, null),
    safe('helpers', () => hlen(db.K.helpers), null),
    safe('ai', async () => (await db.redis().get(db.K.aiLast)) || null, null),
    safe('watch', async () => (await db.getWatch()) || null, null),
  ]);
  const [orders, stockOut, stockLow, waitlist, groups, helpers, aiLast, watch] = extras;

  const w = windowOf(s);
  const ch2 = s.channel2?.id
    ? {
        label: s.channel2.username ? `@${s.channel2.username}` : s.channel2.title || String(s.channel2.id),
        enabled: Boolean(s.channel2.enabled),
        markup: num(s.channel2.markup_percent),
      }
    : null;

  return {
    generated_at: now,
    today,
    settings: {
      phone: s.phone,
      channels: (s.channels || []).map((c) => ({ title: c.title || String(c.id), active: Boolean(c.active) })),
      channel2: ch2,
      toggles: {
        new_channel: Boolean(s.new_channel),
        new_story: Boolean(s.new_story),
        new_group: Boolean(s.new_group),
        discount_channel: Boolean(s.discount_channel),
        discount_story: Boolean(s.discount_story),
        random_album: Boolean(s.random_album),
        random_story: Boolean(s.random_story),
        restock_post: s.restock_post !== false,
        ai_desc: Boolean(s.ai_desc),
        mark_sold: s.mark_sold !== false,
        price_update: s.price_update !== false,
        hashtags: s.hashtags !== false,
        wm_on: s.wm_on !== false,
        health: s.health !== false,
        backup_auto: s.backup_auto !== false,
        weekly_report: s.weekly_report !== false,
      },
      pace: { on: paceOn(s), from: fmtHHMM(w.from), to: fmtHHMM(w.to), every: w.every, story_hours: storyPeriod(s) / 3600 },
    },
    today_stats: dayRow(today, st),
    today_raw: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, num(v)])),
    days: days.map((d, i) => dayRow(d, stats[i] || {})),
    queues: {
      channel: num(queue),
      restock: num(restockQ),
      ch2: num(ch2Q),
      story: storyQ && { total: storyQ.total, per_day: storyQ.perDay, next: storyQ.next, eta: storyQ.eta },
    },
    health: {
      last_tick_at: num(health.last_tick_at) || null,
      last_ok_at: num(health.last_ok_at) || null,
      bito_ms: num(health.bito_ms) || null,
      bito_streak: num(health.bito_streak),
      last_check_at: num(watch?.last_checked_at) || null,
    },
    profiles,
    extras: { orders, stock_out: stockOut, stock_low: stockLow, waitlist, groups, helpers, ai_last: aiLast },
    errors,
    post_sales: await safe('post sales', () => postSales({ days: 7 }), null),
    problems,
  };
}
