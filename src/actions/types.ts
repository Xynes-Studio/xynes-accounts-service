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
  | 'accounts.invites.accept';

export type ActionContext = {
  workspaceId: string | null;
  userId: string | null;
  requestId: string;
  user?: {
    email?: string;
    name?: string;
    avatarUrl?: string;
  };
};

export type ActionHandler<Payload, Result> = (
  payload: Payload,
  ctx: ActionContext,
) => Promise<Result>;
