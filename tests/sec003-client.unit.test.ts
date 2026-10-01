import { describe, expect, it } from 'bun:test';
import { createAuthzClient } from '../src/infra/authz/authzClient';
import {
  internalRequestOperation,
  verifyInternalRequest,
} from '../src/infra/security/internal-request';
import { accountsIdentity } from './support/internal-request';
const workspaceId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
it('serializes each request once so the signature binds the actual transmitted bytes', async () => {
  let serializations = 0;
  const payload = {
    userId,
    workspaceId,
    roleKey: 'workspace_owner',
    actionKey: 'cms.entry.read',
    toJSON() {
      serializations++;
      return {
        userId,
        workspaceId,
        roleKey: 'workspace_owner',
        actionKey: 'cms.entry.read',
        serialization: serializations,
      };
    },
  };
  const fetchImpl: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body);
      const headers = new Headers(init?.headers);
      expect(
        verifyInternalRequest(
          headers.get('X-Internal-Service-Token') ?? '',
          {
            audience: 'authz-service',
            operation: internalRequestOperation('authz-service', new URL(url).pathname, body),
            url,
            method: 'POST',
            headers,
            body,
          },
          [{ issuer: 'accounts', keyId: 'a1', publicKey: accountsIdentity.publicKey }],
        ),
      ).toBe(true);
      return Response.json({ allowed: true, ok: true, data: { roles: [] } });
    },
    { preconnect: fetch.preconnect },
  );
  const client = createAuthzClient({ baseUrl: 'http://authz', fetchImpl });
  await client.assignRole(payload);
  await client.checkPermission(payload);
  await client.listRolesForWorkspace(payload);
  expect(serializations).toBe(3);
});
describe('SEC-003 accounts authz client', () => {
  it('signs each operation with accounts identity and delegated actor/request context', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = String(init?.body);
        const headers = new Headers(init?.headers);
        const operation = internalRequestOperation('authz-service', new URL(url).pathname, body);
        expect(
          verifyInternalRequest(
            headers.get('X-Internal-Service-Token') ?? '',
            { audience: 'authz-service', operation, url, method: 'POST', headers, body },
            [{ issuer: 'accounts', keyId: 'a1', publicKey: accountsIdentity.publicKey }],
          ),
        ).toBe(true);
        expect(headers.get('X-Workspace-Id')).toBe(workspaceId);
        expect(headers.get('X-XS-User-Id')).toBe(userId);
        expect(headers.get('X-Request-Id')).toBe('incoming-request');
        calls.push(operation);
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              allowed: true,
              roles: [
                { userId, roleKey: 'workspace_owner' },
                { userId: 1, roleKey: true },
              ],
            },
          }),
        );
      },
      { preconnect: fetch.preconnect },
    );
    const client = createAuthzClient({ baseUrl: 'http://authz', fetchImpl });
    const context = {
      requestId: 'incoming-request',
      userId,
      workspaceId,
      actor: { kind: 'user' as const, userId },
    };
    await client.assignRole({ userId, workspaceId, roleKey: 'workspace_owner' }, context);
    expect(
      await client.checkPermission({ userId, workspaceId, actionKey: 'cms.entry.read' }, context),
    ).toBe(true);
    expect(await client.listRolesForWorkspace({ workspaceId }, context)).toEqual([
      { userId, roleKey: 'workspace_owner' },
    ]);
    expect(calls).toEqual(['authz.assignRole', 'authz.check', 'authz.listRolesForWorkspace']);
  });
  it('fails closed without a private identity even if legacy credentials exist', () => {
    const saved = process.env.INTERNAL_REQUEST_PRIVATE_KEY_FILE;
    try {
      delete process.env.INTERNAL_REQUEST_PRIVATE_KEY_FILE;
      expect(() =>
        createAuthzClient({ baseUrl: 'http://authz', internalServiceToken: 'legacy-token' }),
      ).toThrow('Internal request identity misconfigured');
    } finally {
      process.env.INTERNAL_REQUEST_PRIVATE_KEY_FILE = saved;
    }
  });
  it('redacts errors, denies unavailable checks, and filters malformed role responses', async () => {
    const client = createAuthzClient({
      baseUrl: 'http://authz',
      fetchImpl: Object.assign(async () => new Response('unavailable', { status: 503 }), {
        preconnect: fetch.preconnect,
      }),
    });
    expect(await client.checkPermission({ userId, workspaceId: null, actionKey: 'x' })).toBe(false);
    await expect(
      client.assignRole({ userId, workspaceId, roleKey: 'workspace_owner' }),
    ).rejects.toThrow('Failed to assign role');
    await expect(client.listRolesForWorkspace({ workspaceId })).rejects.toThrow(
      'Failed to list roles',
    );
  });
});

it('validates base URL configuration', () => {
  expect(() => createAuthzClient({ baseUrl: '' })).toThrow('AUTHZ_SERVICE_URL is not set');
  expect(() => createAuthzClient({ baseUrl: 'invalid' })).toThrow('AUTHZ_SERVICE_URL is invalid');
});
it('redacts network failures and enforces per-operation timeouts', async () => {
  const failed: typeof fetch = Object.assign(
    async () => {
      throw new Error('private network detail');
    },
    { preconnect: fetch.preconnect },
  );
  const client = createAuthzClient({ baseUrl: 'http://authz', fetchImpl: failed });
  await expect(
    client.assignRole({ userId, workspaceId, roleKey: 'workspace_owner' }),
  ).rejects.toThrow('Failed to reach authz service');
  await expect(client.checkPermission({ userId, workspaceId, actionKey: 'x' })).rejects.toThrow(
    'Failed to reach authz service',
  );
  await expect(client.listRolesForWorkspace({ workspaceId })).rejects.toThrow(
    'Failed to reach authz service',
  );
  const aborted: typeof fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
    { preconnect: fetch.preconnect },
  );
  const timed = createAuthzClient({ baseUrl: 'http://authz', fetchImpl: aborted, timeoutMs: 10 });
  await expect(
    timed.assignRole({ userId, workspaceId, roleKey: 'workspace_owner' }),
  ).rejects.toThrow('timed out');
  await expect(timed.checkPermission({ userId, workspaceId, actionKey: 'x' })).rejects.toThrow(
    'timed out',
  );
  await expect(timed.listRolesForWorkspace({ workspaceId })).rejects.toThrow('timed out');
});
it('handles malformed/legacy check and listing responses safely', async () => {
  for (const body of [
    'invalid-json',
    'null',
    '{}',
    '{"allowed":true}',
    '{"ok":true,"data":{}}',
    '{"ok":true,"data":{"roles":[]}}',
  ]) {
    const fake: typeof fetch = Object.assign(async () => new Response(body), {
      preconnect: fetch.preconnect,
    });
    const client = createAuthzClient({ baseUrl: 'http://authz', fetchImpl: fake, timeoutMs: -1 });
    expect(await client.checkPermission({ userId, workspaceId, actionKey: 'x' })).toBe(
      body === '{"allowed":true}',
    );
    expect(await client.listRolesForWorkspace({ workspaceId })).toEqual([]);
  }
});
