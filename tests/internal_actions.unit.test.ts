import { describe, it, expect, beforeAll } from 'bun:test';
import app from '../src/app';
import { INTERNAL_SERVICE_TOKEN } from './support/internal-auth';
import { registerAccountsActions } from '../src/actions/register';

const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '550e8400-e29b-41d4-a716-446655440001';

describe('Internal Accounts Actions Endpoint (Unit)', () => {
  beforeAll(() => {
    registerAccountsActions();
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

  it('returns 400 for missing X-XS-User-Id', async () => {
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
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MISSING_HEADER');
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
