import { getActionHandler } from './registry';
import { ActionContext, AccountsActionKey } from './types';
import { UnknownActionError } from './errors';

export async function executeAccountsAction(
  actionKey: AccountsActionKey,
  payload: unknown,
  ctx: ActionContext,
) {
  const handler = getActionHandler(actionKey);
  if (!handler) {
    throw new UnknownActionError(actionKey);
  }
  return handler(payload as any, ctx);
}
