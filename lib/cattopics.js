// Guruhda kategoriya bo'yicha forum temalari: har asosiy kategoriya uchun bitta tema (kerak bo'lganda ochiladi, eslab qolinadi).
import { categoryStats } from './stock.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

const TOPICS = (key) => db.K.flag(`${key}:topics`);

// product yozuvi → kategoriya yo'li (asosiy → eng pastki) va asosiy kategoriya nomi
export async function catResolver(s) {
  let nodes = null;
  try {
    nodes = (await categoryStats(s)).nodes;
  } catch (e) {
    console.error(`cattopics: categories unavailable: ${errText(e)}`);
  }
  const path = (r) => {
    const out = [];
    for (let n = r?.cat && nodes ? nodes.get(r.cat) : null, i = 0; n && i < 10; i++, n = n.parent && nodes.get(n.parent)) out.unshift(n.name);
    return out.length ? out : r?.catn ? [r.catn] : [];
  };
  return { path, root: (r) => path(r)[0] || 'Kategoriyasiz' };
}
export const rootResolver = async (s) => (await catResolver(s)).root;

export const topicReason = (e) => {
  const m = errText(e);
  return /not a forum/i.test(m) ? 'guruhda «Mavzular» (Topics) yoqilmagan' : /rights|administrator/i.test(m) ? "botda «Mavzularni boshqarish» huquqi yo'q" : m.slice(0, 200);
};

// kategoriya temasining id'si; yo'q bo'lsa ochadi (xato bo'lsa tashlaydi)
export async function threadFor(key, emoji, chat, root) {
  const field = `${chat}|${root}`;
  const id = await db.redis().hget(TOPICS(key), field);
  if (id) return Number(id);
  const t = await tg('createForumTopic', { chat_id: chat, name: `${emoji ? `${emoji} ` : ''}${root}`.slice(0, 120) });
  await db.redis().hset(TOPICS(key), { [field]: t.message_thread_id });
  return Number(t.message_thread_id);
}

export const forgetThread = (key, chat, root) => db.redis().hdel(TOPICS(key), `${chat}|${root}`).catch(() => {});
export const isThreadGone = (e) => /thread not found|TOPIC_DELETED|TOPIC_CLOSED|message thread/i.test(errText(e));
