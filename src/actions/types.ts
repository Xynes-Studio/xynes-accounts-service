export type AccountsActionKey =
  | 'accounts.ping'
  | 'accounts.user.readSelf'
  | 'accounts.workspace.readCurrent'
  | 'accounts.workspaceMember.ensure'
  | 'accounts.me.getOrCreate'
  | 'accounts.workspaces.listForUser'
  | 'accounts.workspaces.create';

export type ActionContext = {
  workspaceId: string | null;
  userId: string;
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
