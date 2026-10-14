import { createHash } from 'node:crypto';

// Telegram secret_token allows only A-Z a-z 0-9 _ - (1..256); other secrets are hashed.
export function webhookSecretToken() {
  const raw = process.env.WEBHOOK_SECRET || process.env.SECRET;
  if (!raw) {
    return null;
  }
  return /^[A-Za-z0-9_-]{1,256}$/.test(raw) ? raw : createHash('sha256').update(raw).digest('hex');
}
