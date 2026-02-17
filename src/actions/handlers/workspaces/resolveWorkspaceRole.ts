import type { AuthzClient } from '../../../infra/authz/authzClient';
import { DomainError } from '@xynes/errors';
import { logger } from '../../../infra/logger';

export type WorkspaceRole = 'workspace_owner' | 'workspace_admin' | 'workspace_member';

const ROLE_PRIORITY: WorkspaceRole[] = ['workspace_owner', 'workspace_admin', 'workspace_member'];
const SAFE_FALLBACK_ROLE: WorkspaceRole = 'workspace_member';

function normalizeWorkspaceRole(roleKey: string): WorkspaceRole {
  if (
    roleKey === 'workspace_owner' ||
    roleKey === 'workspace_admin' ||
    roleKey === 'workspace_member'
  ) {
    return roleKey;
  }
  return SAFE_FALLBACK_ROLE;
}

function shouldFallbackOnLookupError(error: unknown): boolean {
  if (error instanceof DomainError) {
    return error.code === 'BAD_GATEWAY' || error.code === 'GATEWAY_TIMEOUT';
  }
  return error instanceof Error;
}

export async function resolveWorkspaceRoleForUser(
  authzClient: AuthzClient,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole> {
  let assignments: Awaited<ReturnType<AuthzClient['listRolesForWorkspace']>>;
  try {
    assignments = await authzClient.listRolesForWorkspace({ workspaceId, userIds: [userId] });
  } catch (error) {
    if (!shouldFallbackOnLookupError(error)) {
      throw error;
    }
    logger.warn('[ResolveWorkspaceRole] Failed to resolve role from authz, using fallback role', {
      workspaceId,
      userId,
      fallbackRole: SAFE_FALLBACK_ROLE,
      errorCode: error instanceof DomainError ? error.code : 'UNKNOWN',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return SAFE_FALLBACK_ROLE;
  }

  const roles = new Set(
    assignments.map((assignment) => normalizeWorkspaceRole(assignment.roleKey)),
  );
  for (const role of ROLE_PRIORITY) {
    if (roles.has(role)) return role;
  }
  return SAFE_FALLBACK_ROLE;
}
