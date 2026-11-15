// Guruhda kategoriya bo'yicha forum temalari: har asosiy kategoriya uchun bitta tema (kerak bo'lganda ochiladi, eslab qolinadi).
import { categoryStats } from './stock.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

const TOPICS = (key) => db.K.flag(`${key}:topics`);

// product yozuvi → asosiy (eng yuqori) kategoriya nomi
export async function rootResolver(s) {
  let nodes = null;
  try {
    nodes = (await categoryStats(s)).nodes;
  } catch (e) {
    console.error(`cattopics: categories unavailable: ${errText(e)}`);
  }
  return (r) => {
    let n = r?.cat && nodes ? nodes.get(r.cat) : null;
    for (let i = 0; n && n.parent && nodes.get(n.parent) && i < 10; i++) n = nodes.get(n.parent);
    return n?.name || r?.catn || 'Kategoriyasiz';
  };
}

export const topicReason = (e) => {
  const m = errText(e);
  return /not a forum/i.test(m) ? 'guruhda «Mavzular» (Topics) yoqilmagan' : /rights|administrator/i.test(m) ? "botda «Mavzularni boshqarish» huquqi yo'q" : m.slice(0, 200);
};

// kategoriya temasining id'si; yo'q bo'lsa ochadi (xato bo'lsa tashlaydi)
export async function threadFor(key, emoji, chat, root) {
  const field = `${chat}|${root}`;
  const id = await db.redis().hget(TOPICS(key), field);
  if (id) return Number(id);
  const t = await tg('createForumTopic', { chat_id: chat, name: `${emoji} ${root}`.slice(0, 120) });
  await db.redis().hset(TOPICS(key), { [field]: t.message_thread_id });
  return Number(t.message_thread_id);
}

export const forgetThread = (key, chat, root) => db.redis().hdel(TOPICS(key), `${chat}|${root}`).catch(() => {});
export const isThreadGone = (e) => /thread not found|TOPIC_DELETED|TOPIC_CLOSED|message thread/i.test(errText(e));
