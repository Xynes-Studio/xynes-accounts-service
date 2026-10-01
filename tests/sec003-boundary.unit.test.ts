import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { requireInternalServiceAuth } from '../src/middleware/internal-service-auth';
import { signedInit } from './support/internal-request';
import { createHmac } from 'node:crypto';
const path = '/internal/accounts-actions';
const body = JSON.stringify({
  actionKey: 'accounts.workspaces.create',
  payload: { name: 'A', slug: 'a' },
});
function fixture() {
  const app = new Hono();
  let calls = 0;
  app.use('*', requireInternalServiceAuth());
  app.post(path, (c) => {
    calls++;
    return c.json({ ok: true });
  });
  return { app, calls: () => calls };
}
describe('SEC-003 accounts deputy boundary', () => {
  it('rejects correctly signed shared HS256 credentials and static tokens', async () => {
    const f = fixture();
    const key = 'shared-compromised-sibling-test-key';
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ aud: 'accounts-service', internal: true, iat: now, exp: now + 60, requestId: 'forged' })}`;
    const token = `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
    for (const value of [token, 'legacy-token']) {
      const response = await f.app.request(path, {
        method: 'POST',
        headers: { 'X-Internal-Service-Token': value },
        body,
      });
      expect(response.status).toBe(403);
    }
    expect(f.calls()).toBe(0);
  });
  it('rejects tampering and missing configuration before handler execution', async () => {
    const f = fixture();
    const init = signedInit(path, { method: 'POST', body, headers: { 'X-XS-User-Id': 'actor-a' } });
    const headers = new Headers(init.headers);
    headers.set('X-XS-User-Id', 'actor-b');
    expect((await f.app.request(path, { ...init, headers })).status).toBe(403);
    const saved = process.env.INTERNAL_REQUEST_TRUST_FILE;
    try {
      delete process.env.INTERNAL_REQUEST_TRUST_FILE;
      expect((await f.app.request(path, init)).status).toBe(500);
    } finally {
      process.env.INTERNAL_REQUEST_TRUST_FILE = saved;
    }
    expect(f.calls()).toBe(0);
  });
});
