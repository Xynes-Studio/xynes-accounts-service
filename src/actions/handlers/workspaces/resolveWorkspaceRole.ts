import type { AuthzClient } from '../../../infra/authz/authzClient';

export type WorkspaceRole = 'workspace_owner' | 'workspace_admin' | 'workspace_member';

const ROLE_PRIORITY: WorkspaceRole[] = ['workspace_owner', 'workspace_admin', 'workspace_member'];

function normalizeWorkspaceRole(roleKey: string): WorkspaceRole {
  if (
    roleKey === 'workspace_owner' ||
    roleKey === 'workspace_admin' ||
    roleKey === 'workspace_member'
  ) {
    return roleKey;
  }
  return 'workspace_member';
}

export async function resolveWorkspaceRoleForUser(
  authzClient: AuthzClient,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole> {
  const assignments = await authzClient.listRolesForWorkspace({ workspaceId, userIds: [userId] });
  const roles = new Set(
    assignments.map((assignment) => normalizeWorkspaceRole(assignment.roleKey)),
  );
  for (const role of ROLE_PRIORITY) {
    if (roles.has(role)) return role;
  }
  return 'workspace_member';
}
