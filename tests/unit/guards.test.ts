import { describe, it, expect, mock } from 'bun:test';
import { DomainError } from '@xynes/errors';
import {
  requireUserId,
  requireWorkspaceId,
  requirePermission,
  requireUserActor,
  requireAuthenticatedActor,
} from '../../src/actions/guards';
import type { ActionContext } from '../../src/actions/types';

const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const API_KEY_ID = '550e8400-e29b-41d4-a716-446655440099';
const API_KEY_PREFIX = 'a1b2c3d4';

function makeUserCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    requestId: 'req-test',
    actor: { kind: 'user', userId: USER_ID },
    ...overrides,
  };
}

function makeApiKeyCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WORKSPACE_ID,
    userId: null,
    requestId: 'req-test',
    actor: { kind: 'api_key', apiKeyId: API_KEY_ID, keyPrefix: API_KEY_PREFIX },
    ...overrides,
  };
}

describe('requireUserId (backward compatibility)', () => {
  it('returns userId for user actor', () => {
    expect(requireUserId(makeUserCtx())).toBe(USER_ID);
  });

  it('throws UNAUTHORIZED when userId is null', () => {
    expect(() => requireUserId(makeUserCtx({ userId: null, actor: undefined }))).toThrow(
      DomainError,
    );
  });
});

describe('requireWorkspaceId', () => {
  it('returns workspaceId when present', () => {
    expect(requireWorkspaceId(makeUserCtx())).toBe(WORKSPACE_ID);
  });

  it('throws MISSING_CONTEXT when null', () => {
    expect(() => requireWorkspaceId(makeUserCtx({ workspaceId: null }))).toThrow(DomainError);
  });
});

describe('requireUserActor (PFU-1)', () => {
  it('returns userId for user actor', () => {
    expect(requireUserActor(makeUserCtx())).toBe(USER_ID);
  });

  it('rejects api_key actor with FORBIDDEN_ACTOR_KIND (403)', () => {
    let captured: DomainError | null = null;
    try {
      requireUserActor(makeApiKeyCtx());
    } catch (err) {
      captured = err as DomainError;
    }
    expect(captured).not.toBeNull();
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured!.code).toBe('FORBIDDEN_ACTOR_KIND');
    expect((captured as unknown as { statusCode: number }).statusCode).toBe(403);
  });

  it('rejects ctx with no actor and no userId (UNAUTHORIZED)', () => {
    const ctx: ActionContext = {
      workspaceId: WORKSPACE_ID,
      userId: null,
      requestId: 'req',
    };
    expect(() => requireUserActor(ctx)).toThrow(DomainError);
  });

  it('falls back to ctx.userId when actor is undefined (legacy callers)', () => {
    // Pre-PFU-1 ctx had no `actor` field; routes used `userId` directly.
    // requireUserActor must keep that path working so any non-migrated
    // caller keeps the same observable behaviour.
    const ctx: ActionContext = {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      requestId: 'req',
    };
    expect(requireUserActor(ctx)).toBe(USER_ID);
  });
});

describe('requireAuthenticatedActor (PFU-1)', () => {
  it('returns the user actor when present', () => {
    const actor = requireAuthenticatedActor(makeUserCtx());
    expect(actor).toEqual({ kind: 'user', userId: USER_ID });
  });

  it('returns the api_key actor when present', () => {
    const actor = requireAuthenticatedActor(makeApiKeyCtx());
    expect(actor).toEqual({ kind: 'api_key', apiKeyId: API_KEY_ID, keyPrefix: API_KEY_PREFIX });
  });

  it('throws UNAUTHORIZED when no actor and no userId', () => {
    const ctx: ActionContext = {
      workspaceId: WORKSPACE_ID,
      userId: null,
      requestId: 'req',
    };
    expect(() => requireAuthenticatedActor(ctx)).toThrow(DomainError);
  });

  it('synthesises a user actor when only ctx.userId is present (legacy callers)', () => {
    const ctx: ActionContext = {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      requestId: 'req',
    };
    const actor = requireAuthenticatedActor(ctx);
    expect(actor).toEqual({ kind: 'user', userId: USER_ID });
  });
});

describe('requirePermission (PFU-1: actor-aware)', () => {
  it('calls authzClient.checkPermission for user actor', async () => {
    const checkPermission = mock(async () => true);
    const authzClient = {
      checkPermission,
      assignRole: async () => {},
      listRolesForWorkspace: async () => [],
    } as any;

    await requirePermission(authzClient, makeUserCtx(), 'platform.api_keys.list');
    expect(checkPermission).toHaveBeenCalledTimes(1);
  });

  it('throws FORBIDDEN when authzClient denies user actor', async () => {
    const authzClient = {
      checkPermission: async () => false,
      assignRole: async () => {},
      listRolesForWorkspace: async () => [],
    } as any;

    await expect(
      requirePermission(authzClient, makeUserCtx(), 'platform.api_keys.list'),
    ).rejects.toThrow(DomainError);
  });

  it('SKIPS authzClient.checkPermission for api_key actor (gateway-enforced)', async () => {
    // Gateway has already enforced scopes against route.actionKey;
    // re-running an authz user check for an API-key actor would be a
    // layering violation (no user identity to check against).
    const checkPermission = mock(async () => false);
    const authzClient = {
      checkPermission,
      assignRole: async () => {},
      listRolesForWorkspace: async () => [],
    } as any;

    // Even though authzClient would deny, the api_key path short-
    // circuits and never calls it.
    await requirePermission(authzClient, makeApiKeyCtx(), 'platform.api_keys.list');
    expect(checkPermission).toHaveBeenCalledTimes(0);
  });

  it('uses resolved user actor userId when ctx.userId is null (CodeRabbit fix)', async () => {
    // Regression for PR #12 CodeRabbit Major: a context that carries
    // `actor: { kind: 'user', userId }` but null `ctx.userId` must still
    // authorise via the actor's userId, not 401 on the legacy
    // `requireUserId(ctx)` fallback.
    const passedUserIds: (string | null | undefined)[] = [];
    const authzClient = {
      checkPermission: async (req: { userId: string }) => {
        passedUserIds.push(req.userId);
        return true;
      },
      assignRole: async () => {},
      listRolesForWorkspace: async () => [],
    } as any;

    const ctx: ActionContext = {
      workspaceId: WORKSPACE_ID,
      userId: null, // legacy mirror field deliberately not populated
      requestId: 'req',
      actor: { kind: 'user', userId: USER_ID },
    };

    await requirePermission(authzClient, ctx, 'platform.api_keys.list');
    expect(passedUserIds).toEqual([USER_ID]);
  });

  it('falls back to ctx.userId when no actor is present (legacy callers)', async () => {
    // Pre-PFU-1 callers that only set ctx.userId continue to work
    // exactly as before — requireUserId is the fallback path.
    const passedUserIds: (string | null | undefined)[] = [];
    const authzClient = {
      checkPermission: async (req: { userId: string }) => {
        passedUserIds.push(req.userId);
        return true;
      },
      assignRole: async () => {},
      listRolesForWorkspace: async () => [],
    } as any;

    const ctx: ActionContext = {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      requestId: 'req',
    };

    await requirePermission(authzClient, ctx, 'platform.api_keys.list');
    expect(passedUserIds).toEqual([USER_ID]);
  });
});
