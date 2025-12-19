import { AccountsActionKey, ActionHandler } from './types';

const registry: Record<string, ActionHandler<any, any>> = {};

export function registerAction<Payload, Result>(
  key: AccountsActionKey,
  handler: ActionHandler<Payload, Result>,
) {
  registry[key] = handler;
}

export function getActionHandler(key: AccountsActionKey) {
  return registry[key];
}
