import { describe, it, expect, beforeAll } from 'bun:test';
import app from '../src/app';
import { INTERNAL_SERVICE_TOKEN } from './support/internal-auth';
import { registerAccountsActions } from '../src/actions/register';
import { registerAction } from '../src/actions/registry';

const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '550e8400-e29b-41d4-a716-446655440001';

describe('Internal Accounts Actions Endpoint (Unit)', () => {
  beforeAll(() => {
    registerAccountsActions();

    // Stub out the /me action so this unit suite doesn't require a real DB.
    registerAction('accounts.me.getOrCreate', async (_payload: unknown, ctx: any) => {
      return {
        user: {
          id: ctx.userId,
          email: ctx.user?.email ?? null,
          displayName: ctx.user?.name ?? null,
          avatarUrl: ctx.user?.avatarUrl ?? null,
        },
        workspaces: [],
      };
    });

    // Stub new workspace actions so this unit suite doesn't require DB/network.
    registerAction('accounts.workspaces.listForUser', async (_payload: unknown, ctx: any) => {
      return {
        workspaces: [
          {
            id: WORKSPACE_ID,
            name: 'Acme Inc',
            slug: 'acme',
            planType: 'free',
          },
        ],
        userId: ctx.userId,
      };
    });

    registerAction('accounts.workspaces.create', async (payload: any, ctx: any) => {
      return {
        id: WORKSPACE_ID,
        name: payload?.name ?? 'Acme Inc',
        slug: payload?.slug ?? 'acme',
        planType: 'free',
        createdBy: ctx.userId,
      };
    });

    registerAction('accounts.invites.resolve', async () => {
      return {
        id: 'invite-1',
        workspaceId: WORKSPACE_ID,
        workspaceSlug: 'acme',
        workspaceName: 'Acme Inc',
        inviterName: 'Owner',
        inviterEmail: 'owner@acme.com',
        inviteeEmail: 'invitee@acme.com',
        role: 'workspace_member',
        roleKey: 'workspace_member',
        status: 'pending',
        expiresAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
      };
    });

    registerAction('accounts.invites.accept', async () => {
      return {
        accepted: true,
        workspaceId: WORKSPACE_ID,
        roleKey: 'workspace_member',
        workspaceMemberCreated: true,
        workspace: {
          id: WORKSPACE_ID,
          name: 'Acme Inc',
          slug: 'acme',
          planType: 'free',
          role: 'workspace_member',
        },
      };
    });

    registerAction('accounts.user.updateSelf', async (payload: any, ctx: any) => {
      return {
        id: ctx.userId,
        email: ctx.user?.email ?? 'me@example.com',
        displayName: payload.displayName,
        avatarUrl: ctx.user?.avatarUrl ?? null,
      };
    });
  });

  it('returns 401 for missing X-Internal-Service-Token', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workspace-Id': WORKSPACE_ID,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 for mismatched X-Internal-Service-Token', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': 'wrong-token',
        'X-Workspace-Id': WORKSPACE_ID,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 for missing X-Workspace-Id', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MISSING_HEADER');
    expect(body.meta?.requestId).toBeDefined();
  });

  it('returns 401 for missing X-XS-User-Id', async () => {
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

  it('returns 400 for invalid header UUIDs', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-Workspace-Id': 'not-a-uuid',
        'X-XS-User-Id': 'also-not-a-uuid',
      },
      body: JSON.stringify({ actionKey: 'accounts.ping', payload: {} }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_HEADER');
  });

  it('returns 400 for invalid request body', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-Workspace-Id': WORKSPACE_ID,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({ notActionKey: true }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid request body');
  });

  it('returns 400 for unknown actionKey', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-Workspace-Id': WORKSPACE_ID,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({ actionKey: 'accounts.unknown.action', payload: {} }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNKNOWN_ACTION');
  });

  it('returns 400 for payload validation error', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-Workspace-Id': WORKSPACE_ID,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({
        actionKey: 'accounts.workspaceMember.ensure',
        payload: { role: 'superadmin' },
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Payload validation failed');
  });

  it('returns 200 and ok envelope for accounts.ping', async () => {
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
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ pong: true });
    expect(body.meta?.requestId).toBeDefined();
  });

  it('allows accounts.me.getOrCreate without X-Workspace-Id (workspaceScoped=false)', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-XS-User-Id': USER_ID,
        'X-XS-User-Email': 'me@example.com',
        'X-XS-User-Name': 'Me',
        'X-XS-User-Avatar-Url': 'https://example.com/me.png',
      },
      body: JSON.stringify({ actionKey: 'accounts.me.getOrCreate', payload: {} }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(
      expect.objectContaining({
        user: expect.objectContaining({ id: USER_ID, email: 'me@example.com' }),
        workspaces: [],
      }),
    );
  });

  it('allows accounts.user.updateSelf without X-Workspace-Id (workspaceScoped=false)', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-XS-User-Id': USER_ID,
        'X-XS-User-Email': 'me@example.com',
      },
      body: JSON.stringify({
        actionKey: 'accounts.user.updateSelf',
        payload: { displayName: 'Alice Doe' },
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(
      expect.objectContaining({
        id: USER_ID,
        email: 'me@example.com',
        displayName: 'Alice Doe',
      }),
    );
  });

  it('rejects accounts.user.updateSelf when payload has extra keys (z.strict)', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({
        actionKey: 'accounts.user.updateSelf',
        payload: { displayName: 'Alice Doe', extra: true },
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects accounts.user.updateSelf when displayName has control characters', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({
        actionKey: 'accounts.user.updateSelf',
        payload: { displayName: 'Alice\nDoe' },
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('allows accounts.workspaces.listForUser without X-Workspace-Id (workspaceScoped=false)', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({ actionKey: 'accounts.workspaces.listForUser', payload: {} }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(
      expect.objectContaining({
        userId: USER_ID,
        workspaces: expect.any(Array),
      }),
    );
  });

  it('rejects accounts.workspaces.listForUser when payload has extra keys (z.strict)', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({
        actionKey: 'accounts.workspaces.listForUser',
        payload: { unexpected: true },
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('allows accounts.workspaces.create without X-Workspace-Id (workspaceScoped=false)', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({
        actionKey: 'accounts.workspaces.create',
        payload: { name: 'Acme Inc', slug: 'acme' },
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(
      expect.objectContaining({
        id: WORKSPACE_ID,
        name: 'Acme Inc',
        slug: 'acme',
        planType: 'free',
        createdBy: USER_ID,
      }),
    );
  });

  it('rejects accounts.workspaces.create for missing required fields', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({
        actionKey: 'accounts.workspaces.create',
        payload: {},
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('allows public accounts.invites.resolve without user/workspace headers', async () => {
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
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(
      expect.objectContaining({
        id: 'invite-1',
        workspaceId: WORKSPACE_ID,
        workspaceSlug: 'acme',
        role: 'workspace_member',
        roleKey: 'workspace_member',
      }),
    );
  });

  it('allows accounts.invites.accept without workspace header and returns 201', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({
        actionKey: 'accounts.invites.accept',
        payload: { token: 'x'.repeat(64) },
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(
      expect.objectContaining({
        accepted: true,
        workspaceId: WORKSPACE_ID,
        roleKey: 'workspace_member',
        workspace: expect.objectContaining({
          id: WORKSPACE_ID,
          slug: 'acme',
          role: 'workspace_member',
        }),
      }),
    );
  });

  it('returns 413 when request body exceeds configured limit', async () => {
    const tooLarge = 'a'.repeat(1024 * 1024 + 2048);
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-Workspace-Id': WORKSPACE_ID,
        'X-XS-User-Id': USER_ID,
      },
      body: JSON.stringify({ actionKey: 'accounts.ping', payload: { tooLarge } }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(413);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('http://localhost/internal/accounts-actions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-Workspace-Id': WORKSPACE_ID,
        'X-XS-User-Id': USER_ID,
      },
      body: '{ definitely-not-json ',
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_JSON');
  });
});
