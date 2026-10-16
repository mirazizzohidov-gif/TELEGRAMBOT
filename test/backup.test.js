// node --test — "💾 Zaxira" (backup / restore) and SECRET_OLD while the secret is being replaced.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemRedis } from './_mem.js';

process.env.BOT_TOKEN = 'T';
const store = await import('../lib/store.js');
const redis = new MemRedis();
store.setRedis(redis);
const bk = await import('../lib/backup.js');

let sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = url.split('/').pop();
  sent.push({ method, body: opts.body });
  return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
};

async function seed() {
  redis.m.clear();
  await redis.set(store.K.settings, { phone: '+998901112233', channels: [{ id: '@ch', active: true }], channel2: { id: '-1002', markup_percent: 30 }, wm_pos: 'tl', story_bcs: { BIZ2: false }, bot_token: 'LEAK', api_key_x: 'LEAK' });
  await redis.hset(store.K.helpers, { 777: { id: '777', name: 'Vali', dest: { id: '-100500' } } });
  await redis.hset(store.K.groups, { '-100500': { id: '-100500', title: 'Ombor', status: 'administrator' } });
  await redis.hset(store.K.knownChannels, { '-100777': { id: '-100777', title: 'Yangi' } });
  await redis.hset(store.K.biz, { BIZ1: { id: 'BIZ1', username: 'shop' } });
  await redis.hset(store.K.randomBlacklist, { 501: { sku: '501' } });
  await redis.hset(store.K.aiDesc, { P1: { text: 'admin yozgan', by: 'admin' }, P2: { text: 'ai yozgan', by: 'ai' } });
  await redis.set(`${store.K.flag('wm')}:logo`, Buffer.from('PNGDATA').toString('base64'));
  // must NOT be in a backup
  await redis.rpush(store.K.queue, { sku: 'q' });
  await redis.hset(store.K.sent, { 1: { x: 1 } });
  await redis.set(`${store.K.flag('posts')}:reg`, 'x');
  await redis.hset(store.K.stats(store.today()), { posted: 5 });
  await redis.set('bito:cache:total', 9);
}

test('backup: settings, helpers, groups, channels, profiles, blacklist, admin descriptions, logo — no queues / cache / secrets', async () => {
  await seed();
  const b = await bk.buildBackup();
  assert.equal(b.format, 'bito-telegram-bot-backup');
  assert.equal(b.version, 1);
  assert.deepEqual(Object.keys(b.data).sort(), ['ai_desc_admin', 'biz', 'groups', 'helpers', 'known_channels', 'logo', 'random_blacklist', 'settings']);
  assert.equal(b.data.settings.phone, '+998901112233');
  assert.equal(b.data.settings.wm_pos, 'tl');
  assert.ok(!('bot_token' in b.data.settings) && !('api_key_x' in b.data.settings));
  assert.equal(b.data.helpers['777'].name, 'Vali');
  assert.deepEqual(Object.keys(b.data.ai_desc_admin), ['P1']);
  assert.equal(Buffer.from(b.data.logo, 'base64').toString(), 'PNGDATA');
  const json = JSON.stringify(b);
  for (const bad of ['LEAK', '"q"', 'cache', 'posted']) assert.ok(!json.includes(bad), bad);
});

test('restore file: wrong JSON / format / version / broken parts refused', () => {
  assert.match(bk.parseBackup('{oops').error, /JSON/);
  assert.match(bk.parseBackup(JSON.stringify({ format: 'x', version: 1, data: { settings: {} } })).error, /format/);
  assert.match(bk.parseBackup(JSON.stringify({ format: bk.FORMAT, version: 2, data: { settings: {} } })).error, /versiya/);
  assert.match(bk.parseBackup(JSON.stringify({ format: bk.FORMAT, version: 1, data: {} })).error, /sozlamalar/);
  assert.match(bk.parseBackup(JSON.stringify({ format: bk.FORMAT, version: 1, data: { settings: {}, helpers: [1] } })).error, /helpers/);
  assert.match(bk.parseBackup('').error, /bo'sh/);
  const ok = bk.parseBackup(JSON.stringify({ format: bk.FORMAT, version: 1, created_at: '2026-10-16T00:00:00Z', data: { settings: { phone: '1', secret_x: 'S' } } }));
  assert.ok(ok.ok && ok.backup.data.settings.phone === '1' && !('secret_x' in ok.backup.data.settings));
});

test('diff + restore: each part replaced; queues untouched; AI descriptions kept', async () => {
  await seed();
  const file = await bk.buildBackup();
  // the state changes after the backup
  await redis.set(store.K.settings, { phone: '+998900000000', channels: [], hashtags: false });
  await redis.del(store.K.helpers);
  await redis.hset(store.K.helpers, { 888: { id: '888', name: 'Yangi' } });
  await redis.del(`${store.K.flag('wm')}:logo`);
  await redis.hset(store.K.aiDesc, { P1: { text: 'boshqa', by: 'admin' }, P3: { text: 'x', by: 'admin' } });
  const lines = bk.diffBackup(await bk.buildBackup(), file);
  const text = lines.join('\n');
  assert.ok(text.includes("⚙️ Sozlamalar:") && text.includes('phone: +998900000000 → +998901112233') && text.includes('hashtags: false → —'), text);
  assert.ok(text.includes('👥 Yordamchilar: +1, −1 (jami 1)'), text);
  assert.ok(text.includes('🖼 Logo: zaxiradagi logo'), text);
  await bk.applyBackup(file);
  assert.deepEqual(await redis.get(store.K.settings), file.data.settings);
  assert.deepEqual(Object.keys(await redis.hgetall(store.K.helpers)), ['777']);
  assert.equal(Buffer.from(await redis.get(`${store.K.flag('wm')}:logo`), 'base64').toString(), 'PNGDATA');
  const desc = await redis.hgetall(store.K.aiDesc);
  assert.deepEqual(Object.keys(desc).sort(), ['P1', 'P2']);
  assert.equal(desc.P1.text, 'admin yozgan');
  assert.equal((await redis.lrange(store.K.queue, 0, -1)).length, 1, 'the queue is not touched');
  assert.deepEqual(bk.diffBackup(await bk.buildBackup(), file), [], 'after restoring: nothing to change');
});

test('daily at 03:00 Tashkent: once a day, last 7 kept, sent to the owner quietly; switch off', async () => {
  await seed();
  const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:00`);
  sent = [];
  assert.equal(await bk.backupTick({}, { now: at('2026-10-10', '02:50') }), null);
  assert.deepEqual(await bk.backupTick({}, { now: at('2026-10-10', '03:05') }), { saved: true });
  assert.equal(await bk.backupTick({}, { now: at('2026-10-10', '09:00') }), null, 'once a day');
  const doc = sent.find((c) => c.method === 'sendDocument').body;
  assert.ok(doc instanceof FormData && doc.get('chat_id') === '5812004211' && doc.get('disable_notification') === 'true');
  assert.match(doc.get('document').name, /^bot-zaxira-2026-10-10_\d{4}\.json$/);
  const parsed = bk.parseBackup(await doc.get('document').text());
  assert.ok(parsed.ok && parsed.backup.reason === 'daily');
  for (let d = 11; d <= 20; d++) await bk.backupTick({}, { now: at(`2026-10-${d}`, '03:01') });
  const list = await bk.listBackups();
  assert.equal(list.length, 7);
  assert.equal(await bk.backupTick({ backup_auto: false }, { now: at('2026-10-21', '04:00') }), null);
});

test('SECRET_OLD: accepted next to SECRET while replacing; empty -> ignored; webhook token too', async () => {
  const { secretMatches, checkCron } = await import('../lib/request.js');
  const { webhookSecretTokens, webhookSecretToken } = await import('../lib/webhook-secret.js');
  process.env.SECRET = 'new_secret_123';
  delete process.env.SECRET_OLD;
  delete process.env.WEBHOOK_SECRET;
  assert.equal(secretMatches('new_secret_123'), true);
  assert.equal(secretMatches('old_secret_456'), false);
  assert.equal(secretMatches(undefined), false);
  assert.deepEqual(webhookSecretTokens(), ['new_secret_123']);
  process.env.SECRET_OLD = 'old_secret_456';
  assert.equal(secretMatches('old_secret_456'), true);
  assert.deepEqual(webhookSecretTokens(), ['new_secret_123', 'old_secret_456']);
  assert.equal(webhookSecretToken(), 'new_secret_123', 'setWebhook always sets the new one');
  process.env.SECRET_OLD = '';
  assert.equal(secretMatches(''), false);
  assert.equal(secretMatches('old_secret_456'), false);
  // the webhook on its own WEBHOOK_SECRET: SECRET_OLD does not touch it
  process.env.SECRET_OLD = 'old_secret_456';
  process.env.WEBHOOK_SECRET = 'wh_only';
  assert.deepEqual(webhookSecretTokens(), ['wh_only']);
  delete process.env.WEBHOOK_SECRET;
  // cron: Bearer CRON_SECRET or x-secret (new or old)
  process.env.CRON_SECRET = 'cron_1';
  const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json() {} });
  const r1 = res();
  assert.equal(checkCron({ headers: { 'x-secret': 'old_secret_456' } }, r1), true);
  const r2 = res();
  assert.equal(checkCron({ headers: { authorization: 'Bearer cron_1' } }, r2), true);
  const r3 = res();
  assert.equal(checkCron({ headers: { 'x-secret': 'nope' } }, r3), false);
  assert.equal(r3.code, 401);
  delete process.env.SECRET_OLD;
});
