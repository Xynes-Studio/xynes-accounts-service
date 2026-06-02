import { describe, it, expect } from 'bun:test';

import { noopMailer } from '../../../src/infra/mail/noopMailer';

describe('noopMailer (MAIL-2)', () => {
  it('resolves to { messageId: null } without throwing', async () => {
    const result = await noopMailer.sendInvite({
      to: 'someone@example.com',
      inviterName: 'Alice',
      workspaceName: 'Acme',
      inviteUrl: 'http://localhost:3100/invite/abc',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    expect(result).toEqual({ messageId: null });
  });

  it('is frozen — its `sendInvite` cannot be monkey-patched at runtime', () => {
    expect(Object.isFrozen(noopMailer)).toBe(true);
    // Attempts to replace `sendInvite` throw at runtime because the
    // singleton is `Object.freeze`-d. Cast through `unknown` so TS
    // doesn't insist on a `@ts-expect-error` directive that the
    // checker can't always tell will or won't fire (TS is structurally
    // happy with the assignment because `sendInvite` is a function-
    // typed field; the freeze is a runtime invariant).
    expect(() => {
      (noopMailer as unknown as { sendInvite: () => Promise<{ messageId: null }> }).sendInvite =
        async () => ({ messageId: null });
    }).toThrow();
    expect(noopMailer.sendInvite).toBeInstanceOf(Function);
  });

  it('returns a singleton instance — identity is stable across imports', async () => {
    // Re-import the same module: noopMailer must be the same reference.
    // (Bun bundles modules per-process so this is a re-resolution test,
    // not a true second-evaluation; the cache invariant is still
    // important to verify.)
    const { noopMailer: again } = await import('../../../src/infra/mail/noopMailer');
    expect(again).toBe(noopMailer);
  });

  it('returns the same frozen result envelope on every call (no allocation surprise)', async () => {
    const a = await noopMailer.sendInvite({
      to: 'x@y.z',
      inviterName: null,
      workspaceName: 'W',
      inviteUrl: 'http://l/invite/t',
      expiresAt: 'now',
    });
    const b = await noopMailer.sendInvite({
      to: 'x@y.z',
      inviterName: null,
      workspaceName: 'W',
      inviteUrl: 'http://l/invite/t',
      expiresAt: 'now',
    });
    // Reference equality on the result envelope is a deliberate
    // design choice — see noopMailer.ts.
    expect(a).toBe(b);
  });
});
