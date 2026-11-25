// O'z serverimizda (Hetzner) ishlatish: api/*.js fayllarini Vercel'dagidek xizmat qiladi
// va Vercel cron / cron-job.org o'rniga ichki taymerlarni ishga tushiradi.
//   node server.js            (PORT=3000 default, .env o'qiladi)
//   CRON_ON=1 bo'lsa: har 15 daqiqada /api/cron/tick, har kuni 11:00 UTC /api/cron/daily
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// .env (KEY=VALUE qatorlari)
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
// kod ichidagi havolalar (webhook, rasm, OAuth) shu domenni oladi
if (process.env.PUBLIC_HOST) {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = process.env.PUBLIC_HOST;
  process.env.VERCEL_URL = process.env.PUBLIC_HOST;
}
process.env.SELF_HOSTED = '1';

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 60 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp4': 'video/mp4',
};

const handlers = new Map();
async function loadHandler(route) {
  if (handlers.has(route)) return handlers.get(route);
  const file = join(ROOT, 'api', `${route}.js`);
  if (!normalize(file).startsWith(join(ROOT, 'api')) || !existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  const fn = mod.default || mod.handler;
  handlers.set(route, fn);
  return fn;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Vercel'dagi req.body: JSON → obyekt, form → obyekt, matn → string, boshqasi → Buffer
function parseBody(buf, type = '') {
  if (!buf.length) return undefined;
  if (type.includes('application/json')) {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return buf.toString('utf8');
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
  if (type.startsWith('text/')) return buf.toString('utf8');
  return buf;
}

function addHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (body === undefined || body === null) return res.end(), res;
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/octet-stream');
      return res.end(body), res;
    }
    if (typeof body === 'object') return res.json(body);
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(String(body));
    return res;
  };
  res.redirect = (a, b) => {
    const [code, url] = typeof a === 'number' ? [a, b] : [307, a];
    res.statusCode = code;
    res.setHeader('location', url);
    res.end();
    return res;
  };
}

function serveStatic(path, res) {
  const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
  if (rel.split('/').some((p) => p.startsWith('.') || ['node_modules', 'lib', 'api', 'test', 'scripts'].includes(p))) return false;
  for (const [base, any] of [[join(ROOT, 'public'), true], [ROOT, false]]) {
    const file = normalize(join(base, rel));
    if (!file.startsWith(base + '/') || !existsSync(file) || !statSync(file).isFile()) continue;
    const ext = extname(file);
    if (!any && (!TYPES[ext] || ['.js', '.json'].includes(ext) || file.includes('/', base.length + 1))) continue;
    res.statusCode = 200;
    res.setHeader('content-type', TYPES[ext] || 'application/octet-stream');
    res.end(readFileSync(file));
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  addHelpers(res);
  const url = new URL(req.url, 'http://localhost');
  try {
    const m = url.pathname.match(/^\/api\/([A-Za-z0-9_\-/]+?)\/?$/);
    if (m) {
      const fn = await loadHandler(m[1]);
      if (!fn) return res.status(404).json({ ok: false, error: 'Not found' });
      req.query = Object.fromEntries(url.searchParams);
      if (!['GET', 'HEAD'].includes(req.method)) req.body = parseBody(await readRaw(req), req.headers['content-type'] || '');
      await fn(req, res);
      return;
    }
    if (url.pathname === '/health') return res.status(200).json({ ok: true, up: Math.round(process.uptime()) });
    if (serveStatic(url.pathname, res)) return;
    res.status(404).send('Not found');
  } catch (e) {
    console.error(`server ${req.method} ${url.pathname}:`, e);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Server error' });
    else res.end();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;
server.listen(PORT, '127.0.0.1', () => console.log(`server: http://127.0.0.1:${PORT} (host ${process.env.PUBLIC_HOST || '-'})`));

// Ichki taymerlar (Vercel cron / cron-job.org o'rniga). Faqat CRON_ON=1 bo'lsa.
// node:http (fetch emas): fetch 300 soniyadan uzoq tick'da "fetch failed" (headers timeout) berardi
function callCron(path) {
  const headers = process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : { 'x-secret': process.env.SECRET || '' };
  const started = Date.now();
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, path, headers, timeout: 0 }, (res) => {
      res.resume();
      res.on('end', () => {
        console.log(`cron ${path}: ${res.statusCode} (${Math.round((Date.now() - started) / 1000)}s)`);
        resolve();
      });
    });
    req.on('error', (e) => {
      console.error(`cron ${path}: ${e.message || e}`);
      resolve();
    });
    req.end();
  });
}
if (process.env.CRON_ON === '1') {
  let tickBusy = false;
  const tick = async () => {
    if (tickBusy) return;
    tickBusy = true;
    await callCron('/api/cron/tick');
    tickBusy = false;
  };
  let lastQuarter = -1;
  let lastDaily = '';
  setInterval(() => {
    const d = new Date();
    const q = Math.floor(d.getUTCMinutes() / 15);
    if (q !== lastQuarter) {
      lastQuarter = q;
      tick();
    }
    const day = d.toISOString().slice(0, 10);
    if (d.getUTCHours() === 11 && lastDaily !== day) {
      lastDaily = day;
      callCron('/api/cron/daily');
    }
  }, 20000);
  console.log('cron: ichki taymerlar yoqildi (tick 15 daqiqa, daily 11:00 UTC)');
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
