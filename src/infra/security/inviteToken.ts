import { createHash, randomBytes } from 'node:crypto';

export type InviteTokenPair = {
  token: string;
  tokenHash: string;
};

export function hashInviteToken(rawToken: string): string {
  const normalized = rawToken.trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function generateInviteToken(bytes: number = 32): InviteTokenPair {
  if (!Number.isFinite(bytes) || bytes < 16) {
    throw new Error('Invite token must be at least 16 random bytes');
  }

  const token = randomBytes(bytes).toString('base64url');
  const tokenHash = hashInviteToken(token);
  return { token, tokenHash };
}
