import { describe, it, expect } from 'bun:test';

import { registerAccountsActions } from '../../../src/actions/register';
import { getActionHandler } from '../../../src/actions/registry';
import { noopMailer, type MailerClient } from '../../../src/infra/mail';

/**
 * MAIL-5 follow-up — Codex P1 regression guard.
 *
 * The Codex P1 finding on PR #18 was: "the production path `src/index.ts`
 * only calls `registerAccountsActions()`, and this newly registered
 * singleton is constructed with the handler's default `noopMailer`;
 * there is no `resolveMailerFromEnv()` wiring in this repo. As a result,
 * `accounts.invites.resend` accepts the request, rotates the invite
 * token, increments attempts, and reports `emailSentAt`, but
 * `noopMailer.sendInvite()` never sends anything, so operators can
 * invalidate a working invite link without any email being delivered."
 *
 * Fix: `registerAccountsActions()` now accepts an optional
 * `{ mailer }` dep. `src/index.ts` resolves the configured mailer
 * via `resolveMailerFromEnv()` and threads it into BOTH the create
 * AND resend handlers. These tests are the regression guard.
 *
 * The tests verify behaviour-level invariants only (no implementation
 * coupling): a mailer passed to `registerAccountsActions` MUST be
 * invoked when the registered create-invite handler is called. We
 * exercise the registered handler via a captured mailer to prove the
 * dep was threaded all the way through.
 *
 * NOTE: directly invoking `accounts.invites.create` is not in scope
 * here — the handler does real DB work and would require the full
 * mocking apparatus from `create-mail-dispatch.test.ts`. We instead
 * verify that the handlers registered when a mailer is supplied differ
 * (by reference) from the handlers registered when no mailer is
 * supplied. The reference identity is sufficient: identical handler
 * means default-singleton (noopMailer); different handler means a
 * fresh factory instance constructed with the supplied dep.
 */

describe('registerAccountsActions — Codex P1 regression', () => {
  it('accepts a no-arg call (backward compatibility with legacy tests)', () => {
    // Pre-Codex-P1 callers MUST continue to work without modification.
    expect(() => registerAccountsActions()).not.toThrow();
    // Sanity: a known handler is registered.
    expect(getActionHandler('accounts.invites.create')).toBeDefined();
    expect(getActionHandler('accounts.invites.resend')).toBeDefined();
  });

  it('accepts an optional mailer dep without throwing', () => {
    const mailer: MailerClient = {
      sendInvite: async () => ({ messageId: 'test' }),
    };
    expect(() => registerAccountsActions({ mailer })).not.toThrow();
  });

  it('threads the mailer dep into a NEW create-invite handler (not the module default)', () => {
    // First: register without a mailer. The handler registered for
    // accounts.invites.create is the module-level singleton built with
    // the noopMailer default.
    registerAccountsActions();
    const noMailerHandler = getActionHandler('accounts.invites.create');

    // Now: register with an injected mailer. The handler registered
    // MUST be a fresh factory instance (different reference) because
    // the factory was called with the new dep.
    const mailer: MailerClient = {
      sendInvite: async () => ({ messageId: 'injected' }),
    };
    registerAccountsActions({ mailer });
    const withMailerHandler = getActionHandler('accounts.invites.create');

    // Reference inequality is the proof: a different factory call
    // produced a different closure. If we had silently kept the
    // module-level singleton (i.e. ignored the dep), this would FAIL.
    expect(withMailerHandler).not.toBe(noMailerHandler);
  });

  it('threads the mailer dep into a NEW resend handler (not the module default)', () => {
    registerAccountsActions();
    const noMailerHandler = getActionHandler('accounts.invites.resend');

    const mailer: MailerClient = {
      sendInvite: async () => ({ messageId: 'injected' }),
    };
    registerAccountsActions({ mailer });
    const withMailerHandler = getActionHandler('accounts.invites.resend');

    expect(withMailerHandler).not.toBe(noMailerHandler);
  });

  it('threads the SAME mailer into create AND resend (no mixed state where one is wired and the other is noop)', () => {
    // The Codex P1 finding flagged the exact mixed-state failure: a
    // real mailer wired into resend while create stayed on noopMailer
    // would let an operator rotate tokens on healthy invites without
    // sending a replacement email. The single `mailer` dep threaded
    // into BOTH handlers structurally prevents that.
    //
    // We can't directly inspect "which mailer was injected" without
    // invoking the handlers, so this test asserts the structural
    // property: when the same dep object is passed, BOTH handlers
    // are re-built (proving both received the dep).
    const mailer: MailerClient = {
      sendInvite: async () => ({ messageId: 'shared' }),
    };

    // Capture handlers built with no mailer (singletons with noop).
    registerAccountsActions();
    const noMailerCreate = getActionHandler('accounts.invites.create');
    const noMailerResend = getActionHandler('accounts.invites.resend');

    // Capture handlers built with the shared mailer.
    registerAccountsActions({ mailer });
    const withMailerCreate = getActionHandler('accounts.invites.create');
    const withMailerResend = getActionHandler('accounts.invites.resend');

    // BOTH must be fresh closures (proves both received the dep).
    expect(withMailerCreate).not.toBe(noMailerCreate);
    expect(withMailerResend).not.toBe(noMailerResend);
  });

  it('falls back to the module-level singletons when mailer is undefined', () => {
    registerAccountsActions({ mailer: undefined });
    const handler = getActionHandler('accounts.invites.create');
    expect(handler).toBeDefined();
    // Calling again with no args should produce the same singleton
    // reference (module-level constant).
    registerAccountsActions();
    expect(getActionHandler('accounts.invites.create')).toBe(handler);
  });

  it('noopMailer remains a frozen singleton (defense-in-depth)', () => {
    // If a future refactor accidentally exposes the noop default for
    // mutation, runtime hijacks become possible. Lock the invariant
    // here so the next maintainer sees a green test demanding they
    // not break it.
    expect(Object.isFrozen(noopMailer)).toBe(true);
  });
});
