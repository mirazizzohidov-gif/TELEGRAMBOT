// "👥 Foydalanuvchilar": who may open the dashboard and what they may do.
//   👑 admin   — the owner's link (lib/dashboard.js key): everything, plus managing users
//   🛠 manage  — may use the buttons (story now, delete sold-out, journal settings)
//   👁 view    — may only look
// Each user gets an own secret link; removing the user stops that link at once.

import { randomBytes } from 'node:crypto';
import { checkDashboardKey, dashboardUrl } from './dashboard.js';
import * as db from './store.js';

const USERS = () => `${db.K.flag('dashboard')}:users`; // hash id -> { id, name, role, key, created_at, last_at }
const KEYS = () => `${db.K.flag('dashboard')}:keys`; // hash key -> id
export const ROLES = { admin: "👑 Admin", manage: '🛠 Boshqaruvchi', view: "👁 Faqat ko'rish" };
const RANK = { view: 1, manage: 2, admin: 3 };

const r = () => db.redis();
const clean = (s) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, 40);

export const can = (role, need) => (RANK[role] || 0) >= (RANK[need] || 99);

// role of a link key: 'admin' | 'manage' | 'view' | null
export async function roleOf(k) {
  if (typeof k !== 'string' || !/^[a-z0-9]{10,80}$/i.test(k)) return null;
  if (await checkDashboardKey(k).catch(() => false)) return { role: 'admin', name: 'Admin' };
  const id = await r().hget(KEYS(), k);
  if (!id) return null;
  const u = await r().hget(USERS(), String(id));
  if (!u || u.key !== k || !RANK[u.role]) return null;
  if (!u.last_at || Date.now() - u.last_at > 5 * 60000) {
    await r().hset(USERS(), { [u.id]: { ...u, last_at: Date.now() } }).catch(() => {});
  }
  return { role: u.role, name: u.name, id: u.id };
}

export async function listUsers() {
  const all = Object.values((await r().hgetall(USERS())) || {});
  return all
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .map((u) => ({ id: u.id, name: u.name, role: u.role, created_at: u.created_at, last_at: u.last_at || null, url: dashboardUrl(u.key) }));
}

export async function addUser(name, role) {
  const n = clean(name);
  if (!n) return { ok: false, message: 'Ism kiriting' };
  if (!['manage', 'view'].includes(role)) return { ok: false, message: "Huquqni tanlang" };
  const id = randomBytes(6).toString('hex');
  const key = `u${randomBytes(16).toString('hex')}`;
  const u = { id, name: n, role, key, created_at: Date.now(), last_at: null };
  await r().hset(USERS(), { [id]: u });
  await r().hset(KEYS(), { [key]: id });
  return { ok: true, message: `✅ ${n} qo'shildi — havolani nusxalab yuboring`, user: { id, name: n, role, url: dashboardUrl(key) } };
}

export async function setUserRole(id, role) {
  const u = await r().hget(USERS(), String(id || ''));
  if (!u) return { ok: false, message: 'Foydalanuvchi topilmadi' };
  if (!['manage', 'view'].includes(role)) return { ok: false, message: "Huquqni tanlang" };
  await r().hset(USERS(), { [u.id]: { ...u, role } });
  return { ok: true, message: `✅ ${u.name}: ${ROLES[role]}` };
}

// a new link for the same user (the old one stops working)
export async function renewUser(id) {
  const u = await r().hget(USERS(), String(id || ''));
  if (!u) return { ok: false, message: 'Foydalanuvchi topilmadi' };
  const key = `u${randomBytes(16).toString('hex')}`;
  await r().hdel(KEYS(), u.key).catch(() => {});
  await r().hset(KEYS(), { [key]: u.id });
  await r().hset(USERS(), { [u.id]: { ...u, key } });
  return { ok: true, message: `♻️ ${u.name}: yangi havola, eskisi endi ochilmaydi`, url: dashboardUrl(key) };
}

export async function removeUser(id) {
  const u = await r().hget(USERS(), String(id || ''));
  if (!u) return { ok: false, message: 'Foydalanuvchi topilmadi' };
  await r().hdel(KEYS(), u.key).catch(() => {});
  await r().hdel(USERS(), u.id);
  return { ok: true, message: `🗑 ${u.name} o'chirildi — uning havolasi endi ochilmaydi` };
}
