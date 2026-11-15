// Guruhda «Mavzular» yoqilsa Telegram uni superguruhga aylantiradi va chat id o'zgaradi (eski id → migrate_to_chat_id).
// Eski id saqlangan hamma joyda yangisiga almashtiriladi: sozlamalar, qayta yuborish holatlari, tema xotirasi, guruhlar ro'yxati.
import * as db from './store.js';
import { errText } from './util.js';

const seen = new Set();

export async function migrateGroup(oldId, newId) {
  oldId = String(oldId);
  newId = String(newId);
  if (!db.hasRedis() || oldId === newId || seen.has(`${oldId}>${newId}`)) return;
  seen.add(`${oldId}>${newId}`);
  try {
    const s = await db.getSettings();
    const patch = {};
    for (const [k, v] of Object.entries(s)) if ((typeof v === 'string' || typeof v === 'number') && String(v) === oldId) patch[k] = newId;
    if (Object.keys(patch).length) await db.updateSettings(patch);
    for (const key of ['outbf', 'lowbf']) {
      const st = await db.redis().get(db.K.flag(key));
      if (st && String(st.chat) === oldId) await db.redis().set(db.K.flag(key), { ...st, chat: newId, topic: true, topic_err: null, error: null, gone: 0 });
      const tk = db.K.flag(`${key}:topics`);
      const fields = Object.keys((await db.redis().hgetall(tk)) || {}).filter((f) => f.startsWith(`${oldId}|`));
      if (fields.length) await db.redis().hdel(tk, ...fields);
    }
    const g = await db.redis().hget(db.K.groups, oldId);
    if (g) {
      await db.redis().hset(db.K.groups, { [newId]: { ...g, id: newId, type: 'supergroup' } });
      await db.redis().hdel(db.K.groups, oldId);
    }
    console.log(`group migrated ${oldId} -> ${newId} (${Object.keys(patch).join(', ') || 'no settings'})`);
  } catch (e) {
    console.error(`group migrate failed: ${errText(e)}`);
  }
}
