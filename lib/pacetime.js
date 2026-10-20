// "📋 Navbat" time math (no imports, so it is easy to test): the posting window (default 09:00–23:00
// Tashkent) and its slots (default every 15 min: 09:00, 09:15 ... 23:00 = 57 a day).

export const PACE_FROM = '09:00';
export const PACE_TO = '23:00';
export const PACE_EVERY = 15;
// A tick that comes a few minutes late still gets its slot; never later than this after the window.
const GRACE_MIN = 4;
const DAY_MS = 86400000;

export const parseHHMM = (t) => {
  const m = String(t ?? '').match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

export const fmtHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function tashkentMinutes(ms) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(ms))
    .split(':')
    .map(Number);
  return (h % 24) * 60 + m;
}

const tashkentDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });

// { from, to, every } in minutes; every comes already clamped (db.limit).
export function paceWindow(s, every = PACE_EVERY) {
  const from = parseHHMM(s.pace_from) ?? parseHHMM(PACE_FROM);
  const to = parseHHMM(s.pace_to) ?? parseHHMM(PACE_TO);
  return { from, to, every: Math.max(1, Number(every) || PACE_EVERY) };
}

export const slotsPerDay = (w) => (w.to < w.from ? 0 : Math.floor((w.to - w.from) / w.every) + 1);

// The slot of this moment: { day, index, key } or null outside the window.
export function currentSlot(w, ms) {
  const n = slotsPerDay(w);
  const now = tashkentMinutes(ms);
  if (!n || now < w.from) return null;
  const lastAt = w.from + (n - 1) * w.every;
  if (now > lastAt + GRACE_MIN) return null;
  const index = Math.min(n - 1, Math.floor((now - w.from) / w.every));
  const day = tashkentDay(ms);
  return { day, index, key: `${day}:${w.from}:${w.every}:${index}`, at: w.from + index * w.every };
}

// When the n-th waiting post goes out (n >= 1), counting from now: { day: 'YYYY-MM-DD', time: 'HH:MM' }.
// slotFree: whether this moment's slot is still free (the next tick can use it).
export function etaOf(w, n, ms, slotFree = true) {
  const per = slotsPerDay(w);
  if (!per || n < 1) return null;
  const now = tashkentMinutes(ms);
  const cur = currentSlot(w, ms);
  // first slot index still usable today
  let first;
  if (cur) first = slotFree ? cur.index : cur.index + 1;
  else if (now < w.from) first = 0;
  else first = per;
  const leftToday = Math.max(0, per - first);
  let dayOffset;
  let index;
  if (n <= leftToday) {
    dayOffset = 0;
    index = first + n - 1;
  } else {
    const rest = n - leftToday;
    dayOffset = Math.ceil(rest / per);
    index = (rest - 1) % per;
  }
  return { day: tashkentDay(ms + dayOffset * DAY_MS), time: fmtHHMM(w.from + index * w.every), days: dayOffset };
}
