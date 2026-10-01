/** SEC-003 wire contract. Mirrored byte-for-byte in gateway/accounts/authz. */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const contextHeaders = [
  'x-request-id',
  'x-workspace-id',
  'x-xs-actor-type',
  'x-xs-user-id',
  'x-xs-user-email',
  'x-xs-user-name',
  'x-xs-user-avatar-url',
  'x-xs-api-key-id',
  'x-xs-api-key-prefix',
] as const;
const headerSchema = z
  .object({
    alg: z.literal('EdDSA'),
    typ: z.literal('xynes-internal-request+jwt'),
    kid: z.string().min(1).max(128),
  })
  .strict();
const claimsSchema = z
  .object({
    iss: z.string().min(1).max(128),
    aud: z.string().min(1).max(128),
    iat: z.number().int(),
    exp: z.number().int(),
    operation: z.string().min(1).max(256),
    method: z.string().min(1).max(16),
    path: z.string().min(1).max(2048),
    bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
    context: z.array(z.string().max(4096).nullable()).length(contextHeaders.length),
  })
  .strict();
export interface InternalRequest {
  audience: string;
  operation: string;
  url: string;
  method: string;
  headers: Headers;
  body: string | Uint8Array;
}
export interface InternalRequestSigner {
  issuer: string;
  keyId: string;
  privateKey: KeyObject;
}
export interface InternalRequestTrust {
  issuer: string;
  keyId: string;
  publicKey: KeyObject;
}
export class InternalRequestConfigError extends Error {
  constructor() {
    super('Internal request identity misconfigured');
  }
}

export function loadInternalRequestSigner(issuer: 'gateway' | 'accounts'): InternalRequestSigner {
  try {
    const path = process.env.INTERNAL_REQUEST_PRIVATE_KEY_FILE;
    const keyId = process.env.INTERNAL_REQUEST_KEY_ID;
    if (!path || !keyId || keyId.length > 128) throw new InternalRequestConfigError();
    const privateKey = createPrivateKey(readFileSync(path));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new InternalRequestConfigError();
    return { issuer, keyId, privateKey };
  } catch {
    throw new InternalRequestConfigError();
  }
}

const trustSchema = z
  .array(
    z
      .object({
        issuer: z.string().min(1).max(128),
        keyId: z.string().min(1).max(128),
        publicKey: z.string().max(8192),
      })
      .strict(),
  )
  .min(1)
  .max(16);
export function loadInternalRequestTrust(): InternalRequestTrust[] {
  try {
    const path = process.env.INTERNAL_REQUEST_TRUST_FILE;
    if (!path) throw new InternalRequestConfigError();
    const entries = trustSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const seen = new Set<string>();
    return entries.map((entry) => {
      const id = `${entry.issuer}/${entry.keyId}`;
      if (seen.has(id) || !entry.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'))
        throw new InternalRequestConfigError();
      seen.add(id);
      const publicKey = createPublicKey(entry.publicKey);
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new InternalRequestConfigError();
      return { issuer: entry.issuer, keyId: entry.keyId, publicKey };
    });
  } catch {
    throw new InternalRequestConfigError();
  }
}
function snapshot(request: InternalRequest) {
  const url = new URL(request.url);
  return {
    operation: request.operation,
    method: request.method.toUpperCase(),
    path: url.pathname + url.search,
    bodyHash: createHash('sha256').update(request.body).digest('hex'),
    context: contextHeaders.map((name) => request.headers.get(name)),
  };
}
export function signInternalRequest(
  request: InternalRequest,
  signer = loadInternalRequestSigner('gateway'),
  now = Math.floor(Date.now() / 1000),
): string {
  if (!request.headers.get('x-request-id')) request.headers.set('x-request-id', randomUUID());
  const header = headerSchema.parse({
    alg: 'EdDSA',
    typ: 'xynes-internal-request+jwt',
    kid: signer.keyId,
  });
  const claims = claimsSchema.parse({
    iss: signer.issuer,
    aud: request.audience,
    iat: now,
    exp: now + 60,
    ...snapshot(request),
  });
  if (signer.privateKey.type !== 'private' || signer.privateKey.asymmetricKeyType !== 'ed25519')
    throw new InternalRequestConfigError();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), signer.privateKey).toString('base64url')}`;
}
const gatewayAccountsActions = new Set([
  'accounts.ping',
  'accounts.user.readSelf',
  'accounts.user.updateSelf',
  'accounts.workspace.readCurrent',
  'accounts.workspaceMember.ensure',
  'accounts.me.getOrCreate',
  'accounts.workspaces.listForUser',
  'accounts.workspaces.create',
  'accounts.workspace_members.listForWorkspace',
  'accounts.invites.create',
  'accounts.invites.resolve',
  'accounts.invites.accept',
  'accounts.invites.resend',
  'platform.domains.list',
  'platform.domains.create',
  'platform.domains.verify',
  'platform.domains.regenerateVerification',
  'platform.domains.delete',
  'platform.api_keys.list',
  'platform.api_keys.create',
  'platform.api_keys.revoke',
  'platform.api_keys.usage.read',
]);
function permitted(issuer: string, request: InternalRequest): boolean {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST') return false;
  if (request.audience === 'accounts-service') {
    return (
      issuer === 'gateway' &&
      path === '/internal/accounts-actions' &&
      gatewayAccountsActions.has(request.operation)
    );
  }
  if (request.audience !== 'authz-service') return false;
  if (path === '/authz/check' && request.operation === 'authz.check')
    return issuer === 'gateway' || issuer === 'accounts';
  return (
    path === '/internal/authz-actions' &&
    issuer === 'accounts' &&
    ['authz.assignRole', 'authz.listRolesForWorkspace'].includes(request.operation)
  );
}
export function internalRequestOperation(
  audience: string,
  path: string,
  body: Uint8Array | string,
): string {
  if (audience === 'authz-service' && path === '/authz/check') return 'authz.check';
  try {
    const value: unknown = JSON.parse(
      typeof body === 'string' ? body : Buffer.from(body).toString('utf8'),
    );
    return value &&
      typeof value === 'object' &&
      'actionKey' in value &&
      typeof value.actionKey === 'string'
      ? value.actionKey
      : '';
  } catch {
    return '';
  }
}
export function verifyInternalRequest(
  token: string,
  request: InternalRequest,
  trust: readonly InternalRequestTrust[],
  now = Math.floor(Date.now() / 1000),
): boolean {
  try {
    if (token.length > 16384) return false;
    const parts = token.split('.');
    const [head, payload, signature] = parts;
    if (
      parts.length !== 3 ||
      !head ||
      !payload ||
      !signature ||
      parts.some(
        (part) =>
          !/^[A-Za-z0-9_-]+$/.test(part) ||
          Buffer.from(part, 'base64url').toString('base64url') !== part,
      )
    )
      return false;
    const header = headerSchema.parse(JSON.parse(Buffer.from(head, 'base64url').toString('utf8')));
    const claims = claimsSchema.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    const key = trust.find(
      (entry) => entry.issuer === claims.iss && entry.keyId === header.kid,
    )?.publicKey;
    if (
      key?.type !== 'public' ||
      key.asymmetricKeyType !== 'ed25519' ||
      !verify(null, Buffer.from(`${head}.${payload}`), key, Buffer.from(signature, 'base64url'))
    )
      return false;
    if (
      claims.aud !== request.audience ||
      claims.iat > now ||
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 60
    )
      return false;
    if (!permitted(claims.iss, request) || !request.headers.get('x-request-id')) return false;
    const actual = snapshot(request);
    if (
      claims.operation !== actual.operation ||
      claims.method !== actual.method ||
      claims.path !== actual.path ||
      claims.bodyHash !== actual.bodyHash ||
      JSON.stringify(claims.context) !== JSON.stringify(actual.context)
    )
      return false;
    // Authz's workspace comes from its body. It must agree with the signed header.
    if (request.audience === 'authz-service') {
      const body: unknown = JSON.parse(
        typeof request.body === 'string'
          ? request.body
          : Buffer.from(request.body).toString('utf8'),
      );
      if (!body || typeof body !== 'object') return false;
      const target = 'payload' in body ? body.payload : body;
      if (
        target &&
        typeof target === 'object' &&
        'workspaceId' in target &&
        target.workspaceId !== (request.headers.get('x-workspace-id') ?? null)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Bound actual bytes even if Content-Length is missing or dishonest. */
export async function readInternalRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError('Request body too large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    let finished = false;
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        continue;
      }
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RangeError('Request body too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
