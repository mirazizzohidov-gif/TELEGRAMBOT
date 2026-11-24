// BIR MARTALIK (faqat o'z serverimizda): api/envsend.js yuborgan kalitlarni .env ga yozadi.
// /opt/mixbot/.envsync-code fayli bo'lsa va kod mos kelsa ishlaydi, so'ng fayl o'chiriladi.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export default async function handler(req, res) {
  const root = process.cwd();
  const codeFile = join(root, '.envsync-code');
  if (process.env.SELF_HOSTED !== '1' || req.method !== 'POST' || !existsSync(codeFile)) return res.status(404).json({ ok: false });
  const code = readFileSync(codeFile, 'utf8').trim();
  if (!code || req.headers['x-sync-code'] !== code) return res.status(401).json({ ok: false });
  unlinkSync(codeFile);
  const values = req.body && typeof req.body === 'object' ? req.body : {};
  const envFile = join(root, '.env');
  let lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : [];
  const done = [];
  const skipped = [];
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Z0-9_]+$/.test(k) || typeof v !== 'string' || /["\n\r]/.test(v)) {
      skipped.push(k);
      continue;
    }
    lines = lines.filter((l) => !l.startsWith(`${k}=`));
    lines.push(`${k}="${v}"`);
    done.push(k);
  }
  writeFileSync(envFile, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  console.log(`envrecv: ${done.length} ta kalit yozildi${skipped.length ? `, o'tkazildi: ${skipped.join(',')}` : ''}`);
  return res.status(200).json({ ok: true, written: done, skipped });
}
