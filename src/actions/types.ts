export type AccountsActionKey =
  | 'accounts.ping'
  | 'accounts.user.readSelf'
  | 'accounts.user.updateSelf'
  | 'accounts.workspace.readCurrent'
  | 'accounts.workspaceMember.ensure'
  | 'accounts.me.getOrCreate'
  | 'accounts.workspaces.listForUser'
  | 'accounts.workspaces.create'
  | 'accounts.workspace_members.listForWorkspace'
  | 'accounts.invites.create'
  | 'accounts.invites.resolve'
  | 'accounts.invites.accept'
  | 'platform.domains.list'
  | 'platform.domains.create'
  | 'platform.domains.verify'
  | 'platform.domains.regenerateVerification'
  | 'platform.domains.delete'
  | 'platform.api_keys.list'
  | 'platform.api_keys.create'
  | 'platform.api_keys.revoke'
  | 'platform.api_keys.usage.read';

/**
 * PFU-1 — Discriminated actor union for the internal action context.
 *
 * Mirrors `GatewayRequestActor` in `xynes-gateway/src/types/requestAuth.ts`
 * so downstream services can reason about who initiated the request.
 *
 * - `user`:   request authenticated via a user JWT (legacy default).
 * - `api_key`: request authenticated via a workspace API key. The
 *              gateway has already enforced scope/workspace; the
 *              downstream MUST NOT re-run an authz user check.
 *
 * The raw API key is NEVER carried in the actor — only the public
 * `apiKeyId` (UUID) and 8-char `keyPrefix` surface here, matching the
 * gateway's redaction posture.
 */
export type UserActor = {
  kind: 'user';
  userId: string;
};

export type ApiKeyActor = {
  kind: 'api_key';
  apiKeyId: string;
  keyPrefix: string;
};

export type ActionActor = UserActor | ApiKeyActor;

export type ActionContext = {
  workspaceId: string | null;
  userId: string | null;
  requestId: string;
  user?: {
    email?: string;
    name?: string;
    avatarUrl?: string;
  };
  /**
   * PFU-1 — Discriminated actor surface. When present, handlers should
   * branch on `actor.kind` to decide whether to require a human user
   * (e.g. for `createdBy` audit ownership) or accept an API-key actor
   * (e.g. read-only resources). Backward compat: legacy callers that
   * only set `userId` still work via the guards' synthesis fallback.
   */
  actor?: ActionActor;
};

export type ActionHandler<Payload, Result> = (
  payload: Payload,
  ctx: ActionContext,
) => Promise<Result>;
