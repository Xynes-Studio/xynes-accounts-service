import { registerAction } from './registry';
import { pingHandler } from './handlers/ping';
import { readSelfUserHandler } from './handlers/readSelfUser';
import { updateSelfHandler } from './handlers/user/updateSelf';
import { readCurrentWorkspaceHandler } from './handlers/readCurrentWorkspace';
import { ensureWorkspaceMemberHandler } from './handlers/ensureWorkspaceMember';
import { meGetOrCreateHandler } from './handlers/meGetOrCreate';
import { listWorkspacesForUserHandler } from './handlers/workspaces/listForUser';
import { listWorkspaceMembersHandler } from './handlers/workspaces/listMembers';
import { createWorkspaceHandler } from './handlers/workspaces/create';
import { createWorkspaceInviteHandler } from './handlers/invites/create';
import { resolveWorkspaceInviteHandler } from './handlers/invites/resolve';
import { acceptWorkspaceInviteHandler } from './handlers/invites/accept';
import {
  listDomainsHandler,
  createDomainHandler,
  verifyDomainHandler,
  deleteDomainHandler,
} from './handlers/integrations/domains';
import {
  listApiKeysHandler,
  createApiKeyHandler,
  revokeApiKeyHandler,
  readApiKeyUsageHandler,
} from './handlers/integrations/apiKeys';

export function registerAccountsActions() {
  registerAction('accounts.ping', pingHandler);
  registerAction('accounts.user.readSelf', readSelfUserHandler);
  registerAction('accounts.user.updateSelf', updateSelfHandler);
  registerAction('accounts.workspace.readCurrent', readCurrentWorkspaceHandler);
  registerAction('accounts.workspaceMember.ensure', ensureWorkspaceMemberHandler);
  registerAction('accounts.me.getOrCreate', meGetOrCreateHandler);
  registerAction('accounts.workspaces.listForUser', listWorkspacesForUserHandler);
  registerAction('accounts.workspaces.create', createWorkspaceHandler);
  registerAction('accounts.workspace_members.listForWorkspace', listWorkspaceMembersHandler);
  registerAction('accounts.invites.create', createWorkspaceInviteHandler);
  registerAction('accounts.invites.resolve', resolveWorkspaceInviteHandler);
  registerAction('accounts.invites.accept', acceptWorkspaceInviteHandler);

  // ── Platform Domain Actions ───────────────────────────────────
  registerAction('platform.domains.list', listDomainsHandler);
  registerAction('platform.domains.create', createDomainHandler);
  registerAction('platform.domains.verify', verifyDomainHandler);
  registerAction('platform.domains.delete', deleteDomainHandler);

  // ── Platform API Key Actions ──────────────────────────────────
  registerAction('platform.api_keys.list', listApiKeysHandler);
  registerAction('platform.api_keys.create', createApiKeyHandler);
  registerAction('platform.api_keys.revoke', revokeApiKeyHandler);
  registerAction('platform.api_keys.usage.read', readApiKeyUsageHandler);
}
