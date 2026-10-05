// Generated from platform-contracts internal-request-http.test.ts; update the canonical suite and re-export.
import { afterEach, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authenticateInternalRequest,
  internalRequestAudience,
  signInternalRequest,
} from '../src/infra/security/internal-request';

const originalTrust = process.env.INTERNAL_REQUEST_TRUST_FILE;
let directory: string | undefined;
afterEach(() => {
  if (originalTrust === undefined) delete process.env.INTERNAL_REQUEST_TRUST_FILE;
  else process.env.INTERNAL_REQUEST_TRUST_FILE = originalTrust;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it('maps known route aliases and fails closed for unknown services', () => {
  for (const [alias, expected] of [
    ['cms_core', 'cms-service'],
    [' CMS-Core ', 'cms-service'],
    ['docservice', 'doc-service'],
    ['storage_service', 'storage-service'],
    ['telemetry-service', 'telemetry-service'],
    ['accounts', 'accounts-service'],
    ['authz', 'authz-service'],
  ]) {
    expect(internalRequestAudience(alias)).toBe(expected);
  }
  expect(internalRequestAudience('unregistered-service')).toBeNull();
});

it('authenticates actual bounded HTTP bytes and returns redacted rejection results', async () => {
  const keys = generateKeyPairSync('ed25519');
  const body = JSON.stringify({ actionKey: 'cms.entry.create', payload: {} });
  const url = 'http://cms/internal/cms-actions';
  const headers = new Headers({
    'X-Request-Id': 'http-fixture',
    'Content-Type': 'application/json',
  });
  const signer = { issuer: 'gateway', keyId: 'fixture-key', privateKey: keys.privateKey };
  headers.set(
    'X-Internal-Service-Token',
    signInternalRequest(
      {
        audience: 'cms-service',
        operation: 'cms.entry.create',
        url,
        method: 'POST',
        headers,
        body,
      },
      signer,
    ),
  );
  const req = () => new Request(url, { method: 'POST', headers, body });
  delete process.env.INTERNAL_REQUEST_TRUST_FILE;
  expect(await authenticateInternalRequest(new Request(url), 'cms-service', 1024)).toMatchObject({
    ok: false,
    status: 401,
  });
  expect(await authenticateInternalRequest(req(), 'cms-service', 1024)).toEqual({
    ok: false,
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Internal auth misconfigured',
  });
  directory = mkdtempSync(join(tmpdir(), 'request-http-fixture-'));
  const file = join(directory, 'trust.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        issuer: 'gateway',
        keyId: 'fixture-key',
        publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      },
    ]),
  );
  process.env.INTERNAL_REQUEST_TRUST_FILE = file;
  const accepted = await authenticateInternalRequest(req(), 'cms-service', body.length);
  expect(accepted.ok).toBe(true);
  if (accepted.ok) {
    expect(accepted.requestId).toBe('http-fixture');
    expect(Buffer.from(accepted.body).toString()).toBe(body);
  }
  expect(await authenticateInternalRequest(req(), 'cms-service', body.length - 1)).toMatchObject({
    ok: false,
    status: 400,
  });
  const legacy = new Headers(headers);
  legacy.set('X-Internal-Service-Token', 'shared-static-fixture');
  expect(
    await authenticateInternalRequest(
      new Request(url, { method: 'POST', headers: legacy, body }),
      'cms-service',
      1024,
    ),
  ).toMatchObject({ ok: false, status: 403 });
  expect(await authenticateInternalRequest(req(), 'doc-service', 1024)).toMatchObject({
    ok: false,
    status: 403,
  });
});
