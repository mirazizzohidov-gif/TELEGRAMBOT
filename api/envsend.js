// BIR MARTALIK: Vercel'dagi "Sensitive" kalitlarni to'g'ridan-to'g'ri o'z serverimizga (Hetzner) yuboradi.
// Qiymatlar hech kimga ko'rsatilmaydi; faqat qat'iy yozilgan manzilga, server bergan bir martalik kod bilan.
// GET /api/envsend?code=<serverdagi kod>   — ko'chish tugagach bu fayl o'chiriladi.
const TARGET = 'https://188-245-91-98.sslip.io/api/envrecv';
const KEYS = ['ADMIN_IDS', 'BITO_API_KEY', 'BITO_PRICE_ID', 'BOT_TOKEN', 'BUSINESS_CONNECTION_ID', 'CHANNEL_ID', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'REDIS_URL', 'SECRET', 'SECRET_OLD'];

export default async function handler(req, res) {
  if (process.env.VERCEL !== '1') return res.status(404).json({ ok: false });
  const code = String(req.query?.code || '');
  if (!/^[a-f0-9]{32}$/.test(code)) return res.status(400).json({ ok: false, error: 'code' });
  const values = Object.fromEntries(KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  try {
    const r = await fetch(TARGET, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-code': code }, body: JSON.stringify(values), signal: AbortSignal.timeout(20000) });
    const out = await r.json().catch(() => ({}));
    return res.status(200).json({ ok: r.ok, sent: Object.keys(values).length, server: out });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
