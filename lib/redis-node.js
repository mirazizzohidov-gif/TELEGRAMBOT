import { createClient } from 'redis';

// node-redis (TCP, REDIS_URL) behind the same interface as @upstash/redis:
// values are JSON-encoded on write (strings as-is) and JSON-decoded on read.
const enc = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const dec = (v) => {
  if (v === null || v === undefined) {
    return null;
  }
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

// One connection per module instance, reused across warm serverless invocations.
let connecting = null;

function connect(url) {
  if (!connecting) {
    const client = createClient({
      url,
      socket: {
        connectTimeout: 10000,
        reconnectStrategy: (retries) => (retries > 5 ? false : Math.min(retries * 200, 2000)),
      },
    });
    client.on('error', (e) => console.error('redis:', e.message));
    connecting = client.connect().then(
      () => client,
      (e) => {
        connecting = null;
        throw e;
      },
    );
  }
  return connecting;
}

function dropConnection() {
  const old = connecting;
  connecting = null;
  old?.then((c) => c.destroy()).catch(() => {});
}

const isConnectionError = (e) =>
  /closed|socket|connect|ECONN|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timeout|not open/i.test(
    `${e?.name} ${e?.code} ${e?.message}`,
  );

export class NodeRedis {
  constructor(url) {
    this.url = url;
  }

  // Runs a command; on a connection error reconnects once and retries.
  async run(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await connect(this.url);
        if (!client.isOpen) {
          throw Object.assign(new Error('Redis connection is closed'), { name: 'ClientClosedError' });
        }
        return await fn(client);
      } catch (e) {
        if (attempt === 0 && isConnectionError(e)) {
          dropConnection();
          continue;
        }
        throw e;
      }
    }
  }

  get(key) {
    return this.run(async (c) => dec(await c.get(key)));
  }

  set(key, value, opts = {}) {
    const o = {};
    if (opts.ex) o.EX = opts.ex;
    if (opts.nx) o.NX = true;
    return this.run((c) => c.set(key, enc(value), o));
  }

  del(key) {
    return this.run((c) => c.del(key));
  }

  expire(key, seconds) {
    return this.run((c) => c.expire(key, seconds));
  }

  hset(key, fields) {
    const encoded = Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, enc(v)]));
    return this.run((c) => c.hSet(key, encoded));
  }

  hget(key, field) {
    return this.run(async (c) => dec(await c.hGet(key, String(field))));
  }

  hdel(key, ...fields) {
    return this.run((c) => c.hDel(key, fields.map(String)));
  }

  hgetall(key) {
    return this.run(async (c) => {
      const all = await c.hGetAll(key);
      const entries = Object.entries(all || {});
      return entries.length ? Object.fromEntries(entries.map(([f, v]) => [f, dec(v)])) : null;
    });
  }

  hincrby(key, field, n) {
    return this.run((c) => c.hIncrBy(key, field, n));
  }

  rpush(key, ...values) {
    return this.run((c) => c.rPush(key, values.map(enc)));
  }

  lpush(key, ...values) {
    return this.run((c) => c.lPush(key, values.map(enc)));
  }

  lpop(key, count) {
    return this.run(async (c) => {
      if (count === undefined) {
        return dec(await c.lPop(key));
      }
      const list = await c.lPopCount(key, count);
      return list ? list.map(dec) : null;
    });
  }

  lrange(key, start, stop) {
    return this.run(async (c) => (await c.lRange(key, start, stop)).map(dec));
  }

  ltrim(key, start, stop) {
    return this.run((c) => c.lTrim(key, start, stop));
  }

  llen(key) {
    return this.run((c) => c.lLen(key));
  }
}

// For tests: close the cached connection.
export async function closeNodeRedis() {
  const old = connecting;
  connecting = null;
  if (old) {
    await old.then((c) => c.quit()).catch(() => {});
  }
}
