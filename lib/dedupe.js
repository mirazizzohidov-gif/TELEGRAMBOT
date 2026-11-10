// "🧹 Takroriy postlar": the same SKU posted more than once in one channel. The newest post of each SKU
// stays, the older ones are deleted. Built from the post registry (lib/postreg.js): only the bot's own
// channel posts of the last 90 days, made while "❌ SOTILDI" or "💲 Narx yangilash" was on.

import { allPosts, forgetPosts } from './postreg.js';
import { tg } from './telegram.js';
import { clock, errText } from './util.js';

// Already gone from the channel: counted as done and forgotten.
const GONE = /message to delete not found|message_id_invalid/i;
const DELETE_GAP_MS = 300;

// What the bot may do in a chat: { title, type, status, can_delete } — for the "why can't it delete" line.
let meId = null;
export async function chatRights(chat) {
  const out = { chat: String(chat), title: '', type: '', status: '', can_delete: null, error: '' };
  try {
    const c = await tg('getChat', { chat_id: chat });
    out.title = c.title || c.username || '';
    out.type = c.type || '';
  } catch (e) {
    out.error = e.data?.description || errText(e);
    return out;
  }
  try {
    if (!meId) meId = (await tg('getMe')).id;
    const m = await tg('getChatMember', { chat_id: chat, user_id: meId });
    out.status = m.status || '';
    out.can_delete = m.status === 'creator' ? true : m.status === 'administrator' ? Boolean(m.can_delete_messages) : false;
  } catch (e) {
    out.error = e.data?.description || errText(e);
  }
  return out;
}

// [{ chat, sku, name, keep: { pid, mid, at }, remove: [{ pid, mid, at }] }], most copies first.
export async function findDuplicates() {
  const all = await allPosts();
  const groups = new Map();
  for (const [pid, list] of Object.entries(all)) {
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || e.kind !== 'post' || !e.mid || !e.chat) continue;
      const sku = String(e.item?.sku ?? '').trim();
      if (!sku) continue;
      const key = `${e.chat}|${sku}`;
      if (!groups.has(key)) groups.set(key, { chat: String(e.chat), sku, name: String(e.item?.name || ''), posts: [] });
      groups.get(key).posts.push({ pid: String(pid), mid: Number(e.mid), at: Number(e.at) || 0 });
    }
  }
  const dups = [];
  for (const g of groups.values()) {
    const seen = new Set();
    const posts = g.posts.filter((p) => {
      if (seen.has(p.mid)) return false;
      seen.add(p.mid);
      return true;
    });
    if (posts.length < 2) continue;
    posts.sort((a, b) => b.at - a.at || b.mid - a.mid); // newest first
    dups.push({ chat: g.chat, sku: g.sku, name: g.name, keep: posts[0], remove: posts.slice(1) });
  }
  dups.sort((a, b) => b.remove.length - a.remove.length || a.sku.localeCompare(b.sku));
  return dups;
}

// Deletes the older copies. Returns { deleted, gone, failed: [{ sku, chat, mid, why }], left }.
// left: not tried (out of time) — the admin taps again.
// onProgress({ done, total }) is called every few posts (the admin sees "🗑 O'chirilmoqda: 3/8").
export async function deleteDuplicates({ deadline = Date.now() + 200000, onProgress = null } = {}) {
  const dups = await findDuplicates();
  const result = { deleted: 0, gone: 0, failed: [], left: 0, total: dups.reduce((n, g) => n + g.remove.length, 0) };
  let tried = 0;
  if (onProgress) await Promise.resolve(onProgress({ done: 0, total: result.total })).catch(() => {});
  const forget = new Map();
  const drop = (pid, key) => {
    if (!forget.has(pid)) forget.set(pid, []);
    forget.get(pid).push(key);
  };
  for (const g of dups) {
    for (const p of g.remove) {
      if (Date.now() + 5000 > deadline) {
        result.left++;
        continue;
      }
      const key = `${g.chat}:${p.mid}`;
      try {
        await tg('deleteMessage', { chat_id: g.chat, message_id: p.mid }, { deadline });
        result.deleted++;
        drop(p.pid, key);
      } catch (e) {
        const why = e.data?.description || errText(e);
        if (GONE.test(why)) {
          result.gone++;
          drop(p.pid, key);
        } else {
          result.failed.push({ sku: g.sku, chat: g.chat, mid: p.mid, why });
        }
      }
      tried++;
      if (onProgress && (tried % 3 === 0 || tried === result.total)) {
        await Promise.resolve(onProgress({ done: tried, total: result.total })).catch(() => {});
      }
      await clock.sleep(DELETE_GAP_MS);
    }
  }
  for (const [pid, keys] of forget) {
    await forgetPosts(pid, keys).catch((e) => console.error(`dedupe forget ${pid}: ${errText(e)}`));
  }
  return result;
}
