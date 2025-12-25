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

export type AuthzClient = {
  assignRole: (req: AssignRoleRequest) => Promise<void>;
  checkPermission: (req: CheckPermissionRequest) => Promise<boolean>;
};

export type CreateAuthzClientDeps = {
  baseUrl?: string;
  internalServiceToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createAuthzClient({
  baseUrl = process.env.AUTHZ_SERVICE_URL,
  internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN,
  fetchImpl = fetch,
  timeoutMs,
}: CreateAuthzClientDeps = {}): AuthzClient {
  if (!baseUrl) {
    throw new DomainError('AUTHZ_SERVICE_URL is not set', 'INTERNAL_ERROR', 500);
  }
  if (!internalServiceToken) {
    throw new DomainError('INTERNAL_SERVICE_TOKEN is not set', 'INTERNAL_ERROR', 500);
  }

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
    async assignRole(payload: AssignRoleRequest) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), resolvedTimeoutMs);

      let res: Response;
      try {
        res = await fetchImpl(actionEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Service-Token': internalServiceToken,
          },
          body: JSON.stringify({
            actionKey: 'authz.assignRole',
            payload,
          }),
          signal: controller.signal,
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
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

    async checkPermission(payload: CheckPermissionRequest): Promise<boolean> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), resolvedTimeoutMs);

      let res: Response;
      try {
        res = await fetchImpl(checkEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Service-Token': internalServiceToken,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
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

      const record = parsed as Record<string, unknown>;
      if ('allowed' in record) return record.allowed === true;

      // Support envelope responses: { ok: true, data: { allowed: boolean } }
      if (record.ok === true && record.data && typeof record.data === 'object') {
        const data = record.data as Record<string, unknown>;
        return data.allowed === true;
      }

      return false;
    },
  };
}
