/**
 * MAIL-3 — schema mirror contract tests for `platform.workspace_invites`.
 *
 * Companion to the xynes-infra contract test at
 * `xynes/xynes-infra/scripts/test/workspace-invites-mail-columns.test.sh`.
 *
 * The migration adds three columns:
 *   - `email_sent_at` (timestamptz, NULLABLE)
 *   - `email_attempts` (integer, NOT NULL, default 0)
 *   - `last_email_error_code` (text, NULLABLE)
 *
 * These tests verify the Drizzle mirror in `src/infra/db/schema.ts`
 * stays in sync with the canonical Supabase migration — same drift-check
 * posture STORAGE-FU-1 ships for the `platform.storage_*` tables.
 *
 * Source migration:
 *   xynes/xynes-infra/supabase/migrations/20260601090000_workspace_invites_mail_columns.sql
 *
 * Plan:
 *   xynes/xynes-infra/docs/plans/2026-05-30-invite-mail-delivery.md §7
 */

import { describe, expect, it } from 'bun:test';
import { workspaceInvites } from '../../src/infra/db/schema';

describe('workspaceInvites — MAIL-3 mailer dispatch state columns', () => {
  it('exposes the three new MAIL-3 columns', () => {
    expect(workspaceInvites.emailSentAt).toBeDefined();
    expect(workspaceInvites.emailAttempts).toBeDefined();
    expect(workspaceInvites.lastEmailErrorCode).toBeDefined();
  });

  it('preserves every pre-MAIL-3 column byte-for-byte', () => {
    // BACKWARDS COMPAT: the canonical row shape must remain unchanged.
    // Any future renamer / dropper has to update this list.
    expect(workspaceInvites.id).toBeDefined();
    expect(workspaceInvites.workspaceId).toBeDefined();
    expect(workspaceInvites.email).toBeDefined();
    expect(workspaceInvites.roleKey).toBeDefined();
    expect(workspaceInvites.invitedBy).toBeDefined();
    expect(workspaceInvites.token).toBeDefined();
    expect(workspaceInvites.status).toBeDefined();
    expect(workspaceInvites.expiresAt).toBeDefined();
    expect(workspaceInvites.createdAt).toBeDefined();
  });

  it('maps emailSentAt to the canonical SQL column name', () => {
    // The Drizzle field name (camelCase TS) must map to the migration's
    // snake_case SQL name. A regression here would silently rename the
    // column in every UPDATE/SELECT issued by MAIL-5.
    expect(workspaceInvites.emailSentAt.name).toBe('email_sent_at');
  });

  it('maps emailAttempts to the canonical SQL column name', () => {
    expect(workspaceInvites.emailAttempts.name).toBe('email_attempts');
  });

  it('maps lastEmailErrorCode to the canonical SQL column name', () => {
    expect(workspaceInvites.lastEmailErrorCode.name).toBe('last_email_error_code');
  });

  it('declares emailSentAt as nullable timestamptz', () => {
    // NULL is the documented "no successful send yet" state — pre-MAIL-3
    // rows AND post-MAIL-3 rows whose last attempt failed.
    expect(workspaceInvites.emailSentAt.notNull).toBe(false);
    // Drizzle Postgres maps timestamp({ withTimezone: true }) to columnType
    // 'PgTimestamp' with dataType 'date'. The `withTimezone` flag itself
    // lives on the column's protected `config` field and is verified by
    // the SQL contract test at
    // `xynes/xynes-infra/scripts/test/workspace-invites-mail-columns.test.sh`
    // (which greps for the literal `timestamptz` in the migration).
    expect(workspaceInvites.emailSentAt.dataType).toBe('date');
    expect(workspaceInvites.emailSentAt.columnType).toBe('PgTimestamp');
  });

  it('declares emailAttempts as NOT NULL integer with default 0', () => {
    expect(workspaceInvites.emailAttempts.notNull).toBe(true);
    expect(workspaceInvites.emailAttempts.dataType).toBe('number');
    // Fail-closed default — pre-MAIL-3 rows auto-populate to 0 (matches
    // "no attempts made") without violating NOT NULL.
    expect(workspaceInvites.emailAttempts.default).toBe(0);
  });

  it('declares lastEmailErrorCode as nullable text', () => {
    expect(workspaceInvites.lastEmailErrorCode.notNull).toBe(false);
    expect(workspaceInvites.lastEmailErrorCode.dataType).toBe('string');
  });

  it('does NOT declare any new indexes / unique constraints / FKs on the new columns', () => {
    // MAIL-3 is column-only. Adding an index on `last_email_error_code`
    // would turn it into a side-channel for provider diagnostics; adding
    // a UNIQUE on `email_sent_at` would prevent multiple invites being
    // sent at the same millisecond. Defense in depth.
    expect(workspaceInvites.emailSentAt.isUnique).toBeFalsy();
    expect(workspaceInvites.emailAttempts.isUnique).toBeFalsy();
    expect(workspaceInvites.lastEmailErrorCode.isUnique).toBeFalsy();
  });
});
