import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  signInternalRequest,
  internalRequestOperation,
} from '../../src/infra/security/internal-request';

// Ephemeral keys are generated per test process, never committed or printed.
export const gatewayIdentity = generateKeyPairSync('ed25519');
export const accountsIdentity = generateKeyPairSync('ed25519');
const dir = mkdtempSync(join(tmpdir(), 'sec003-test-'));
const privateFile = join(dir, 'private.pem');
const trustFile = join(dir, 'trust.json');
writeFileSync(privateFile, accountsIdentity.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
  mode: 0o600,
});
writeFileSync(
  trustFile,
  JSON.stringify([
    {
      issuer: 'gateway',
      keyId: 'g1',
      publicKey: gatewayIdentity.publicKey.export({ type: 'spki', format: 'pem' }),
    },
    {
      issuer: 'accounts',
      keyId: 'a1',
      publicKey: accountsIdentity.publicKey.export({ type: 'spki', format: 'pem' }),
    },
  ]),
  { mode: 0o600 },
);
process.env.INTERNAL_REQUEST_PRIVATE_KEY_FILE = privateFile;
process.env.INTERNAL_REQUEST_KEY_ID = 'a1';
process.env.INTERNAL_REQUEST_TRUST_FILE = trustFile;
export function signedInit(
  path: string,
  init: RequestInit,
  issuer: 'gateway' | 'accounts' = 'gateway',
  audience = 'accounts-service',
): RequestInit {
  const body = typeof init.body === 'string' ? init.body : '';
  const headers = new Headers(init.headers);
  const operation = internalRequestOperation(audience, path, body) || 'accounts.invalidBody';
  const identity = issuer === 'gateway' ? gatewayIdentity : accountsIdentity;
  headers.set(
    'X-Internal-Service-Token',
    signInternalRequest(
      {
        audience,
        operation,
        method: init.method ?? 'POST',
        url: 'http://localhost' + path,
        headers,
        body,
      },
      { issuer, keyId: issuer === 'gateway' ? 'g1' : 'a1', privateKey: identity.privateKey },
    ),
  );
  return { ...init, headers };
}

EventEmitter.prototype.once.call(process, 'exit', () =>
  rmSync(dir, { recursive: true, force: true }),
);
