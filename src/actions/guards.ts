import { DomainError } from '@xynes/errors';
import { createAuthzClient, type AuthzClient } from '../infra/authz/authzClient';
import type { ActionActor, ActionContext } from './types';

// ── Shared Action Guards ────────────────────────────────────────
//
// Reusable context-validation and RBAC helpers for internal action
// handlers. Extracted to eliminate duplication across handler files
// (domains, apiKeys, etc.).
//
// PFU-1 — These guards are now actor-aware. When the request was
// authenticated via a workspace API key (`ctx.actor.kind === 'api_key'`),
// `requirePermission` short-circuits because the gateway has already
// enforced scopes against the route action key. `requireUserActor` exists
// for handlers that MUST have a human user (audit ownership, etc.) and
// rejects api_key actors with `FORBIDDEN_ACTOR_KIND`.

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
 * PFU-1 — Resolve the actor for the current request, synthesising a
 * `user` actor from `ctx.userId` for legacy callers that have not yet
 * been migrated to populate `ctx.actor`. Returns `null` when neither is
 * present (anonymous / public route).
 *
 * Internal helper — exported for guard reuse and testing.
 */
function resolveActor(ctx: ActionContext): ActionActor | null {
  if (ctx.actor) return ctx.actor;
  if (ctx.userId) return { kind: 'user', userId: ctx.userId };
  return null;
}

/**
 * PFU-1 — Require an authenticated actor (user OR api_key).
 *
 * Use this guard at the entry of read-only handlers that don't need
 * a human user identity. For handlers that DO need a human user (audit
 * ownership, etc.), use {@link requireUserActor} instead.
 *
 * @throws DomainError with code UNAUTHORIZED (401) when no actor is present.
 */
export function requireAuthenticatedActor(ctx: ActionContext): ActionActor {
  const actor = resolveActor(ctx);
  if (!actor) {
    throw new DomainError('No authenticated actor in context', 'UNAUTHORIZED', 401);
  }
  return actor;
}

/**
 * PFU-1 — Require a `user` actor and return its userId.
 *
 * Use this guard at the entry of handlers that MUST have a human user
 * identity (e.g. audit ownership fields like `createdBy`/`revokedBy`,
 * or actions that mutate per-user state). API-key actors are rejected
 * with `FORBIDDEN_ACTOR_KIND` (403) — a clear, dedicated error code so
 * the gateway / FE can surface a useful message instead of confusing
 * the caller with "missing X-XS-User-Id" or a generic 403.
 *
 * @throws DomainError with code UNAUTHORIZED (401) when no actor is present.
 * @throws DomainError with code FORBIDDEN_ACTOR_KIND (403) for api_key actors.
 */
export function requireUserActor(ctx: ActionContext): string {
  const actor = requireAuthenticatedActor(ctx);
  if (actor.kind === 'api_key') {
    throw new DomainError(
      'This action requires a user identity and cannot be invoked via a workspace API key',
      'FORBIDDEN_ACTOR_KIND',
      403,
    );
  }
  return actor.userId;
}

/**
 * Check the given action key against the authz service for the current
 * user + workspace context.
 *
 * Self-validating: calls requireUserId internally so callers don't need
 * to guarantee userId is non-null before invoking this guard.
 *
 * PFU-1 — When the actor is `api_key`, this guard SHORT-CIRCUITS and
 * returns successfully without calling the authz service. Rationale: the
 * gateway has already enforced that the API key carries the route's
 * `actionKey` in its scope set (see
 * `xynes-gateway/src/router/dynamicRouter.ts` Task 4). Re-running an
 * authz user check downstream would be a layering violation — the
 * api_key actor does not carry a user identity to check against. The
 * caller is still responsible for using {@link requireUserActor} when
 * the action's semantics actually demand a human user.
 *
 * @throws DomainError with code UNAUTHORIZED (401) when userId is missing
 *         (user actor only).
 * @throws DomainError with code FORBIDDEN (403) when permission is denied
 *         (user actor only).
 */
export async function requirePermission(
  authzClient: AuthzClient,
  ctx: ActionContext,
  actionKey: string,
): Promise<void> {
  const actor = resolveActor(ctx);
  if (actor && actor.kind === 'api_key') {
    // Gateway already enforced scope. Do not invoke the authz user
    // check — there is no user identity to check against.
    return;
  }
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
