import { registerAction } from './registry';
import { pingHandler } from './handlers/ping';
import { readSelfUserHandler } from './handlers/readSelfUser';
import { readCurrentWorkspaceHandler } from './handlers/readCurrentWorkspace';
import { ensureWorkspaceMemberHandler } from './handlers/ensureWorkspaceMember';
import { meGetOrCreateHandler } from './handlers/meGetOrCreate';
import { listWorkspacesForUserHandler } from './handlers/workspaces/listForUser';
import { createWorkspaceHandler } from './handlers/workspaces/create';
import { createWorkspaceInviteHandler } from './handlers/invites/create';
import { resolveWorkspaceInviteHandler } from './handlers/invites/resolve';
import { acceptWorkspaceInviteHandler } from './handlers/invites/accept';

export function registerAccountsActions() {
  registerAction('accounts.ping', pingHandler);
  registerAction('accounts.user.readSelf', readSelfUserHandler);
  registerAction('accounts.workspace.readCurrent', readCurrentWorkspaceHandler);
  registerAction('accounts.workspaceMember.ensure', ensureWorkspaceMemberHandler);
  registerAction('accounts.me.getOrCreate', meGetOrCreateHandler);
  registerAction('accounts.workspaces.listForUser', listWorkspacesForUserHandler);
  registerAction('accounts.workspaces.create', createWorkspaceHandler);
  registerAction('accounts.invites.create', createWorkspaceInviteHandler);
  registerAction('accounts.invites.resolve', resolveWorkspaceInviteHandler);
  registerAction('accounts.invites.accept', acceptWorkspaceInviteHandler);
}
