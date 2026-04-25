import { DomainError } from '@xynes/errors';
import { createAuthzClient, type AuthzClient } from '../infra/authz/authzClient';
import type { ActionContext } from './types';

// ── Shared Action Guards ────────────────────────────────────────
//
// Reusable context-validation and RBAC helpers for internal action
// handlers. Extracted to eliminate duplication across handler files
// (domains, apiKeys, etc.).

/**
 * Require that the action context contains a non-null userId.
 * @throws DomainError with code UNAUTHORIZED (401) when missing.
 */
export function requireUserId(ctx: ActionContext): string {
  if (!ctx.userId) {
    throw new DomainError('Missing userId in auth context', 'UNAUTHORIZED', 401);
  }
  return ctx.userId;
}

/**
 * Require that the action context contains a non-null workspaceId.
 * @throws DomainError with code MISSING_CONTEXT (400) when missing.
 */
export function requireWorkspaceId(ctx: ActionContext): string {
  if (!ctx.workspaceId) {
    throw new DomainError('Missing workspaceId in action context', 'MISSING_CONTEXT', 400);
  }
  return ctx.workspaceId;
}

/**
 * Check the given action key against the authz service for the current
 * user + workspace context.
 *
 * Self-validating: calls requireUserId internally so callers don't need
 * to guarantee userId is non-null before invoking this guard.
 *
 * @throws DomainError with code UNAUTHORIZED (401) when userId is missing.
 * @throws DomainError with code FORBIDDEN (403) when permission is denied.
 */
export async function requirePermission(
  authzClient: AuthzClient,
  ctx: ActionContext,
  actionKey: string,
): Promise<void> {
  const userId = requireUserId(ctx);
  const allowed = await authzClient.checkPermission({
    userId,
    workspaceId: ctx.workspaceId,
    actionKey,
  });
  if (!allowed) {
    throw new DomainError('You do not have permission to perform this action', 'FORBIDDEN', 403);
  }
}

/**
 * Resolve an optional authz client dependency, falling back to the
 * default production client when not provided (for DI in tests).
 */
export function resolveAuthzClient(injected?: AuthzClient): AuthzClient {
  return injected ?? createAuthzClient();
}
