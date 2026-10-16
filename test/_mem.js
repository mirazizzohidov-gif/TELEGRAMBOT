// A small in-memory Redis for the unit tests (the subset of commands the bot uses).
export class MemRedis {
  m = new Map();
  enc = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  dec = (v) => {
    if (v == null) return null;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  async get(k) {
    return this.m.has(k) ? this.dec(this.m.get(k)) : null;
  }
  async set(k, v, o = {}) {
    if (o.nx && this.m.has(k)) return null;
    this.m.set(k, this.enc(v));
    return 'OK';
  }
  async del(k) {
    return this.m.delete(k) ? 1 : 0;
  }
  async expire() {
    return 1;
  }
  h(k) {
    if (!(this.m.get(k) instanceof Map)) this.m.set(k, new Map());
    return this.m.get(k);
  }
  async hset(k, o) {
    for (const [f, v] of Object.entries(o)) this.h(k).set(String(f), this.enc(v));
    return 1;
  }
  async hget(k, f) {
    const h = this.m.get(k);
    return h instanceof Map && h.has(String(f)) ? this.dec(h.get(String(f))) : null;
  }
  async hdel(k, ...fs) {
    const h = this.m.get(k);
    let n = 0;
    for (const f of fs) if (h instanceof Map && h.delete(String(f))) n++;
    return n;
  }
  async hgetall(k) {
    const h = this.m.get(k);
    if (!(h instanceof Map) || !h.size) return null;
    return Object.fromEntries([...h].map(([f, v]) => [f, this.dec(v)]));
  }
  async hincrby(k, f, n) {
    const h = this.h(k);
    const v = Number(this.dec(h.get(String(f))) || 0) + n;
    h.set(String(f), String(v));
    return v;
  }
  l(k) {
    if (!Array.isArray(this.m.get(k))) this.m.set(k, []);
    return this.m.get(k);
  }
  async rpush(k, ...v) {
    this.l(k).push(...v.map(this.enc));
    return this.l(k).length;
  }
  async lpush(k, ...v) {
    for (const x of v) this.l(k).unshift(this.enc(x));
    return this.l(k).length;
  }
  async lrange(k, s, e) {
    const l = this.l(k);
    return l.slice(s, e < 0 ? l.length + e + 1 : e + 1).map(this.dec);
  }
  async ltrim(k, s, e) {
    const l = this.l(k);
    this.m.set(k, l.slice(s < 0 ? Math.max(0, l.length + s) : s, e < 0 ? l.length + e + 1 : e + 1));
    return 'OK';
  }
  async llen(k) {
    return this.l(k).length;
  }
}
