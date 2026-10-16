import { createHash } from 'node:crypto';

// Telegram secret_token allows only A-Z a-z 0-9 _ - (1..256); other secrets are hashed.
const asToken = (raw) => (/^[A-Za-z0-9_-]{1,256}$/.test(raw) ? raw : createHash('sha256').update(raw).digest('hex'));

// The token set with setWebhook: WEBHOOK_SECRET, otherwise SECRET.
export function webhookSecretToken() {
  const raw = process.env.WEBHOOK_SECRET || process.env.SECRET;
  return raw ? asToken(raw) : null;
}

// Tokens the webhook accepts: the current one and — while SECRET is being replaced and the webhook is
// not on its own WEBHOOK_SECRET — the one made from SECRET_OLD (until /api/setup-webhook is called again).
export function webhookSecretTokens() {
  const out = [webhookSecretToken()];
  if (!process.env.WEBHOOK_SECRET && process.env.SECRET_OLD) out.push(asToken(process.env.SECRET_OLD));
  return out.filter(Boolean);
}
