import { registerAction } from './registry';
import { pingHandler } from './handlers/ping';
import { readSelfUserHandler } from './handlers/readSelfUser';
import { readCurrentWorkspaceHandler } from './handlers/readCurrentWorkspace';
import { ensureWorkspaceMemberHandler } from './handlers/ensureWorkspaceMember';

export function registerAccountsActions() {
  registerAction('accounts.ping', pingHandler);
  registerAction('accounts.user.readSelf', readSelfUserHandler);
  registerAction('accounts.workspace.readCurrent', readCurrentWorkspaceHandler);
  registerAction('accounts.workspaceMember.ensure', ensureWorkspaceMemberHandler);
}
