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
import {
  createCreateWorkspaceInviteHandler,
  createWorkspaceInviteHandler as defaultCreateWorkspaceInviteHandler,
} from './handlers/invites/create';
import { resolveWorkspaceInviteHandler } from './handlers/invites/resolve';
import { acceptWorkspaceInviteHandler } from './handlers/invites/accept';
import {
  createResendWorkspaceInviteHandler,
  resendWorkspaceInviteHandler as defaultResendWorkspaceInviteHandler,
} from './handlers/invites/resend';
import {
  listDomainsHandler,
  createDomainHandler,
  verifyDomainHandler,
  regenerateVerificationHandler,
  deleteDomainHandler,
} from './handlers/integrations/domains';
import {
  listApiKeysHandler,
  createApiKeyHandler,
  revokeApiKeyHandler,
  readApiKeyUsageHandler,
} from './handlers/integrations/apiKeys';
import type { MailerClient } from '../infra/mail';

/**
 * MAIL-5 follow-up (Codex P1 fix) — Composition root for accounts
 * actions.
 *
 * Three important properties:
 *
 *   1. **The `mailer` dep is OPTIONAL.** When omitted, both the
 *      `accounts.invites.create` and `accounts.invites.resend`
 *      handlers fall back to the module-level singletons (which
 *      default to `noopMailer`). This preserves the pre-Codex-P1
 *      test posture byte-for-byte — `registerAccountsActions()` is a
 *      valid no-arg call from tests that don't care about mail.
 *
 *   2. **When `mailer` IS supplied**, BOTH invite-touching handlers
 *      (create + resend) are constructed via their factory functions
 *      and the supplied mailer is threaded into both. This closes
 *      the Codex P1 wiring gap: production callers (i.e. `src/index.ts`)
 *      resolve the configured mailer via `resolveMailerFromEnv()` and
 *      pass it here, so the production path actually delivers mail
 *      instead of silently no-op'ing while `resend` rotates tokens.
 *
 *   3. Resend MUST NOT be wired to a real mailer while create stays on
 *      `noopMailer` — that combination would let an operator rotate
 *      tokens on healthy invites without ever sending the replacement
 *      email (the original Codex P1 finding). The single `mailer` dep
 *      threaded into BOTH handlers structurally prevents that mixed
 *      state.
 */
export interface RegisterAccountsActionsDeps {
  /**
   * Mailer used for `accounts.invites.create` + `accounts.invites.resend`.
   * Optional; defaults to the module-level singletons (which default to
   * `noopMailer`) so legacy tests continue to work without modification.
   */
  mailer?: MailerClient;
}

export function registerAccountsActions(deps: RegisterAccountsActionsDeps = {}) {
  // ── Invite handlers — wired with the supplied mailer when present ──
  //
  // If the caller did NOT supply a mailer, we use the module-level
  // singletons (which default to `noopMailer`). This keeps the pre-
  // Codex-P1 test posture intact. Production composition supplies a
  // mailer resolved via `resolveMailerFromEnv()`.
  const createInviteHandler = deps.mailer
    ? createCreateWorkspaceInviteHandler({ mailer: deps.mailer })
    : defaultCreateWorkspaceInviteHandler;
  const resendInviteHandler = deps.mailer
    ? createResendWorkspaceInviteHandler({ mailer: deps.mailer })
    : defaultResendWorkspaceInviteHandler;

  registerAction('accounts.ping', pingHandler);
  registerAction('accounts.user.readSelf', readSelfUserHandler);
  registerAction('accounts.user.updateSelf', updateSelfHandler);
  registerAction('accounts.workspace.readCurrent', readCurrentWorkspaceHandler);
  registerAction('accounts.workspaceMember.ensure', ensureWorkspaceMemberHandler);
  registerAction('accounts.me.getOrCreate', meGetOrCreateHandler);
  registerAction('accounts.workspaces.listForUser', listWorkspacesForUserHandler);
  registerAction('accounts.workspaces.create', createWorkspaceHandler);
  registerAction('accounts.workspace_members.listForWorkspace', listWorkspaceMembersHandler);
  registerAction('accounts.invites.create', createInviteHandler);
  registerAction('accounts.invites.resolve', resolveWorkspaceInviteHandler);
  registerAction('accounts.invites.accept', acceptWorkspaceInviteHandler);
  registerAction('accounts.invites.resend', resendInviteHandler);

  // ── Platform Domain Actions ───────────────────────────────────
  registerAction('platform.domains.list', listDomainsHandler);
  registerAction('platform.domains.create', createDomainHandler);
  registerAction('platform.domains.verify', verifyDomainHandler);
  registerAction('platform.domains.regenerateVerification', regenerateVerificationHandler);
  registerAction('platform.domains.delete', deleteDomainHandler);

  // ── Platform API Key Actions ──────────────────────────────────
  registerAction('platform.api_keys.list', listApiKeysHandler);
  registerAction('platform.api_keys.create', createApiKeyHandler);
  registerAction('platform.api_keys.revoke', revokeApiKeyHandler);
  registerAction('platform.api_keys.usage.read', readApiKeyUsageHandler);
}
