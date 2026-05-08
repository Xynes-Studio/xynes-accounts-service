import { describe, it, expect, beforeAll } from 'bun:test';
import app from '../src/app';
import { INTERNAL_SERVICE_TOKEN } from './support/internal-auth';
import { registerAccountsActions } from '../src/actions/register';
import { registerAction } from '../src/actions/registry';

const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const API_KEY_ID = '550e8400-e29b-41d4-a716-446655440099';
const API_KEY_PREFIX = 'a1b2c3d4';

// PFU-1 — Migrate downstream services to recognise the API-key actor.
//
// Contract (mirrors GatewayRequestActor in xynes-gateway):
//   - When `X-XS-Actor-Type: api_key` is present, the request is treated
//     as an API-key actor; `X-XS-User-Id` is NOT required.
//   - The handler context exposes the actor as a discriminated union:
//     `{ kind: "user"; userId } | { kind: "api_key"; apiKeyId; keyPrefix }`.
//   - Workspace-scoped actions still require `X-Workspace-Id`.
//   - Backward compatibility: existing user JWT path still populates
//     `ctx.userId` and `ctx.user`; new field `ctx.actor` is also populated.

describe('Internal Accounts Actions — API-key actor recognition (PFU-1)', () => {
  beforeAll(() => {
    registerAccountsActions();

    // Stub a workspace-scoped action that captures the resolved ctx so
    // tests can assert on what the handler saw.
    registerAction('accounts.ping', async (_payload: unknown, ctx: any) => {
      return {
        pong: true,
        seenCtx: {
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          actor: ctx.actor ?? null,
        },
      };
    });
  });

  describe('Actor: api_key', () => {
    it('accepts X-XS-Actor-Type: api_key without X-XS-User-Id', async () => {
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
          'X-XS-Actor-Type': 'api_key',
          'X-XS-API-Key-Id': API_KEY_ID,
          'X-XS-API-Key-Prefix': API_KEY_PREFIX,
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.ok).toBe(true);
    });

    it('exposes a discriminated api_key actor on ctx', async () => {
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
          'X-XS-Actor-Type': 'api_key',
          'X-XS-API-Key-Id': API_KEY_ID,
          'X-XS-API-Key-Prefix': API_KEY_PREFIX,
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.seenCtx.actor).toEqual({
        kind: 'api_key',
        apiKeyId: API_KEY_ID,
        keyPrefix: API_KEY_PREFIX,
      });
      // userId is null for api_key actor — no human user is involved.
      expect(body.data.seenCtx.userId).toBeNull();
    });

    it('rejects api_key actor missing X-XS-API-Key-Id with 400 INVALID_HEADER', async () => {
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
          'X-XS-Actor-Type': 'api_key',
          'X-XS-API-Key-Prefix': API_KEY_PREFIX,
          // X-XS-API-Key-Id missing
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_HEADER');
    });

    it('rejects api_key actor with non-UUID X-XS-API-Key-Id with 400 INVALID_HEADER', async () => {
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
          'X-XS-Actor-Type': 'api_key',
          'X-XS-API-Key-Id': 'not-a-uuid',
          'X-XS-API-Key-Prefix': API_KEY_PREFIX,
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_HEADER');
    });

    it('rejects api_key actor missing X-XS-API-Key-Prefix with 400 INVALID_HEADER', async () => {
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
          'X-XS-Actor-Type': 'api_key',
          'X-XS-API-Key-Id': API_KEY_ID,
          // X-XS-API-Key-Prefix missing
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_HEADER');
    });

    it('rejects api_key actor with malformed X-XS-API-Key-Prefix with 400 INVALID_HEADER', async () => {
      // Prefix MUST be exactly 8 hex chars per the gateway contract
      // (xynes-gateway/src/security/apiKeyAuth.ts API_KEY_LOOKUP_PREFIX_LENGTH).
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
          'X-XS-Actor-Type': 'api_key',
          'X-XS-API-Key-Id': API_KEY_ID,
          'X-XS-API-Key-Prefix': 'XYZ', // too short, not hex
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_HEADER');
    });

    it('rejects unknown X-XS-Actor-Type values with 400 INVALID_HEADER', async () => {
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
          'X-XS-Actor-Type': 'service', // not a recognized actor kind
          'X-XS-User-Id': USER_ID,
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_HEADER');
    });

    it('still requires X-Workspace-Id for workspace-scoped actions', async () => {
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-XS-Actor-Type': 'api_key',
          'X-XS-API-Key-Id': API_KEY_ID,
          'X-XS-API-Key-Prefix': API_KEY_PREFIX,
          // X-Workspace-Id missing
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('MISSING_HEADER');
    });
  });

  describe('Actor: user (backward compatibility)', () => {
    it('exposes a discriminated user actor on ctx (default user JWT path)', async () => {
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
          'X-XS-User-Id': USER_ID,
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.seenCtx.actor).toEqual({
        kind: 'user',
        userId: USER_ID,
      });
      // userId is also populated for backward compat.
      expect(body.data.seenCtx.userId).toBe(USER_ID);
    });

    it('still rejects missing X-XS-User-Id when no actor type is provided', async () => {
      // Legacy "no X-XS-Actor-Type header" path: defaults to user actor,
      // so X-XS-User-Id stays required. This preserves the pre-PFU-1
      // behaviour byte-for-byte.
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('still accepts X-XS-Actor-Type: user as an explicit user actor', async () => {
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
          'X-XS-Actor-Type': 'user',
          'X-XS-User-Id': USER_ID,
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.seenCtx.actor).toEqual({
        kind: 'user',
        userId: USER_ID,
      });
    });

    it('rejects X-XS-Actor-Type: user without X-XS-User-Id with 401', async () => {
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
          'X-Workspace-Id': WORKSPACE_ID,
          'X-XS-Actor-Type': 'user',
        },
        body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Public actions remain accessible without any actor', () => {
    it('accepts accounts.invites.resolve with no actor headers', async () => {
      // accounts.invites.resolve is in PUBLIC_ACTION_KEYS — neither
      // user nor api_key actor required. Stubbed by the main internal-
      // actions test file already, so just exercise the route here.
      const req = new Request('http://localhost/internal/accounts-actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        },
        body: JSON.stringify({
          actionKey: 'accounts.invites.resolve',
          payload: { token: 'x'.repeat(64) },
        }),
      });

      const res = await app.fetch(req);
      expect([200, 500]).toContain(res.status);
      // We only care that the actor-aware branch didn't reject
      // public access. A 500 from a stubbed handler is acceptable here
      // because the actor branch passed; the actual happy-path coverage
      // for `accounts.invites.resolve` lives in `internal_actions.unit.test.ts`.
    });
  });
});
