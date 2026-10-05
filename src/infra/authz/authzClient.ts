import {
  signInternalRequest,
  loadInternalRequestSigner,
  type InternalRequestSigner,
} from '../security/internal-request';
import type { ActionContext } from '../../actions/types';
import { randomUUID } from 'node:crypto';
import { DomainError } from '@xynes/errors';

export type AssignRoleRequest = {
  userId: string;
  workspaceId: string;
  roleKey: string;
};

export type CheckPermissionRequest = {
  userId: string;
  workspaceId: string | null;
  actionKey: string;
};

export type ListRolesForWorkspaceRequest = {
  workspaceId: string;
  userIds?: string[];
};

export type WorkspaceRoleAssignment = {
  userId: string;
  roleKey: string;
};

export type AuthzClient = {
  assignRole: (req: AssignRoleRequest, context?: ActionContext) => Promise<void>;
  checkPermission: (req: CheckPermissionRequest, context?: ActionContext) => Promise<boolean>;
  listRolesForWorkspace: (
    req: ListRolesForWorkspaceRequest,
    context?: ActionContext,
  ) => Promise<WorkspaceRoleAssignment[]>;
};

export type CreateAuthzClientDeps = {
  baseUrl?: string;
  /** Legacy input retained for source compatibility; never used to authenticate. */
  internalServiceToken?: string;
  signer?: InternalRequestSigner;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createAuthzClient({
  baseUrl = process.env.AUTHZ_SERVICE_URL,
  signer,
  fetchImpl = fetch,
  timeoutMs,
}: CreateAuthzClientDeps = {}): AuthzClient {
  if (!baseUrl) {
    throw new DomainError('AUTHZ_SERVICE_URL is not set', 'INTERNAL_ERROR', 500);
  }
  let identity: InternalRequestSigner;
  try {
    identity = signer ?? loadInternalRequestSigner('accounts');
  } catch {
    throw new DomainError('Internal request identity misconfigured', 'INTERNAL_ERROR', 500);
  }
  const signedHeaders = (
    url: string,
    body: string,
    operation: string,
    workspaceId: string | null,
    context?: ActionContext,
  ) => {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'X-Request-Id': context?.requestId || randomUUID(),
    });
    if (workspaceId) headers.set('X-Workspace-Id', workspaceId);
    const actorUserId = context?.actor?.kind === 'user' ? context.actor.userId : context?.userId;
    if (actorUserId) headers.set('X-XS-User-Id', actorUserId);
    if (context?.actor) {
      headers.set('X-XS-Actor-Type', context.actor.kind);
      if (context.actor.kind === 'api_key') {
        headers.set('X-XS-API-Key-Id', context.actor.apiKeyId);
        headers.set('X-XS-API-Key-Prefix', context.actor.keyPrefix);
      }
    }
    headers.set(
      'X-Internal-Service-Token',
      signInternalRequest(
        { url, body, operation, audience: 'authz-service', method: 'POST', headers },
        identity,
      ),
    );
    return headers;
  };

  let actionEndpoint: string;
  let checkEndpoint: string;
  try {
    actionEndpoint = new URL('/internal/authz-actions', baseUrl).toString();
    checkEndpoint = new URL('/authz/check', baseUrl).toString();
  } catch (err) {
    throw new DomainError('AUTHZ_SERVICE_URL is invalid', 'INTERNAL_ERROR', 500, { cause: err });
  }

  const resolvedTimeoutMsRaw =
    timeoutMs ??
    (process.env.AUTHZ_CLIENT_TIMEOUT_MS ? Number(process.env.AUTHZ_CLIENT_TIMEOUT_MS) : 5000);
  const resolvedTimeoutMs =
    Number.isFinite(resolvedTimeoutMsRaw) && resolvedTimeoutMsRaw > 0 ? resolvedTimeoutMsRaw : 5000;

  return {
    async assignRole(payload: AssignRoleRequest, context?: ActionContext) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), resolvedTimeoutMs);

      let res: Response;
      try {
        const body = JSON.stringify({ actionKey: 'authz.assignRole', payload });
        res = await fetchImpl(actionEndpoint, {
          method: 'POST',
          headers: signedHeaders(
            actionEndpoint,
            body,
            'authz.assignRole',
            payload.workspaceId,
            context,
          ),
          body: body,
          signal: controller.signal,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new DomainError('Authz service request timed out', 'GATEWAY_TIMEOUT', 504);
        }
        throw new DomainError('Failed to reach authz service', 'BAD_GATEWAY', 502, { cause: err });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        // Avoid leaking details; downstream should log with requestId.
        throw new DomainError('Failed to assign role via authz service', 'BAD_GATEWAY', 502);
      }
    },

    async checkPermission(
      payload: CheckPermissionRequest,
      context?: ActionContext,
    ): Promise<boolean> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), resolvedTimeoutMs);

      let res: Response;
      try {
        const body = JSON.stringify(payload);
        res = await fetchImpl(checkEndpoint, {
          method: 'POST',
          headers: signedHeaders(checkEndpoint, body, 'authz.check', payload.workspaceId, context),
          body: body,
          signal: controller.signal,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new DomainError('Authz service request timed out', 'GATEWAY_TIMEOUT', 504);
        }
        throw new DomainError('Failed to reach authz service', 'BAD_GATEWAY', 502, { cause: err });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        return false;
      }

      const parsed: unknown = await res.json().catch(() => null);
      if (!parsed || typeof parsed !== 'object') return false;

      const record = parsed;
      if ('allowed' in record) return record.allowed === true;

      // Support envelope responses: { ok: true, data: { allowed: boolean } }
      if (
        'ok' in record &&
        record.ok === true &&
        'data' in record &&
        record.data &&
        typeof record.data === 'object'
      ) {
        const data = record.data;
        return 'allowed' in data && data.allowed === true;
      }

      return false;
    },

    async listRolesForWorkspace(
      payload: ListRolesForWorkspaceRequest,
      context?: ActionContext,
    ): Promise<WorkspaceRoleAssignment[]> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), resolvedTimeoutMs);

      let res: Response;
      try {
        const body = JSON.stringify({ actionKey: 'authz.listRolesForWorkspace', payload });
        res = await fetchImpl(actionEndpoint, {
          method: 'POST',
          headers: signedHeaders(
            actionEndpoint,
            body,
            'authz.listRolesForWorkspace',
            payload.workspaceId,
            context,
          ),
          body: body,
          signal: controller.signal,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new DomainError('Authz service request timed out', 'GATEWAY_TIMEOUT', 504);
        }
        throw new DomainError('Failed to reach authz service', 'BAD_GATEWAY', 502, {
          cause: err,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        throw new DomainError('Failed to list roles via authz service', 'BAD_GATEWAY', 502);
      }

      const parsed: unknown = await res.json().catch(() => null);
      if (!parsed || typeof parsed !== 'object') return [];

      const record = parsed;
      if (
        'ok' in record &&
        record.ok === true &&
        'data' in record &&
        record.data &&
        typeof record.data === 'object'
      ) {
        const data = record.data;
        const roles = 'roles' in data ? data.roles : null;
        if (Array.isArray(roles)) {
          return roles.filter(
            (entry: unknown): entry is WorkspaceRoleAssignment =>
              !!entry &&
              typeof entry === 'object' &&
              'userId' in entry &&
              typeof entry.userId === 'string' &&
              'roleKey' in entry &&
              typeof entry.roleKey === 'string',
          );
        }
      }

      return [];
    },
  };
}
