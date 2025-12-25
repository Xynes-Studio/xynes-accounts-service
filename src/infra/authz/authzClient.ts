import { DomainError } from '@xynes/errors';

export type AssignRoleRequest = {
  userId: string;
  workspaceId: string;
  roleKey: string;
};

export type AuthzClient = {
  assignRole: (req: AssignRoleRequest) => Promise<void>;
};

export type CreateAuthzClientDeps = {
  baseUrl?: string;
  internalServiceToken?: string;
  fetchImpl?: typeof fetch;
};

export function createAuthzClient({
  baseUrl = process.env.AUTHZ_SERVICE_URL,
  internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN,
  fetchImpl = fetch,
}: CreateAuthzClientDeps = {}): AuthzClient {
  if (!baseUrl) {
    throw new DomainError('AUTHZ_SERVICE_URL is not set', 'INTERNAL_ERROR', 500);
  }
  if (!internalServiceToken) {
    throw new DomainError('INTERNAL_SERVICE_TOKEN is not set', 'INTERNAL_ERROR', 500);
  }

  const endpoint = new URL('/internal/authz-actions', baseUrl).toString();

  return {
    async assignRole(payload: AssignRoleRequest) {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Token': internalServiceToken,
        },
        body: JSON.stringify({
          actionKey: 'authz.assignRole',
          payload,
        }),
      });

      if (!res.ok) {
        // Avoid leaking details; downstream should log with requestId.
        throw new DomainError('Failed to assign role via authz service', 'BAD_GATEWAY', 502);
      }
    },
  };
}
