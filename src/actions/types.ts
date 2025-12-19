export type AccountsActionKey =
  | 'accounts.ping'
  | 'accounts.user.readSelf'
  | 'accounts.workspace.readCurrent'
  | 'accounts.workspaceMember.ensure';

export type ActionContext = {
  workspaceId: string;
  userId: string;
  requestId: string;
};

export type ActionHandler<Payload, Result> = (
  payload: Payload,
  ctx: ActionContext,
) => Promise<Result>;
