import { pgSchema, uuid, text, timestamp, primaryKey, integer } from 'drizzle-orm/pg-core';

export const identitySchema = pgSchema('identity');
export const platformSchema = pgSchema('platform');

export const users = identitySchema.table('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const workspaces = platformSchema.table('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  createdBy: uuid('created_by').notNull(),
  planType: text('plan_type').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const workspaceMembers = platformSchema.table(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    status: text('status').notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
  }),
);

export const workspaceInvites = platformSchema.table('workspace_invites', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  email: text('email').notNull(),
  roleKey: text('role_key').notNull(),
  invitedBy: uuid('invited_by').notNull(),
  // SECURITY: Store a one-way hash of the raw invite token.
  // The raw token should never be stored in the DB.
  token: text('token').notNull().unique(),
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // ── MAIL-3 — mailer dispatch state ────────────────────────────────────
  // Source migration: xynes/xynes-infra/supabase/migrations/
  //   20260601090000_workspace_invites_mail_columns.sql
  //
  // `emailSentAt` — timestamp of the most recent SUCCESSFUL
  //   mailer.sendInvite return. NULL = "no successful send yet"
  //   (pre-MAIL-3 rows, or never attempted, or last attempt failed).
  emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
  // `emailAttempts` — total dispatch attempts (success + failure).
  //   MAIL-5 bumps atomically via `SET email_attempts = email_attempts + 1`.
  //   Default 0 matches the pre-MAIL-3 / never-attempted state.
  emailAttempts: integer('email_attempts').notNull().default(0),
  // `lastEmailErrorCode` — closed-set MailerErrorCode from MAIL-2
  //   (RECIPIENT_INVALID | PROVIDER_UNAVAILABLE | RATE_LIMITED |
  //    TEMPLATE_RENDER_FAILED | PROVIDER_REJECTED) or NULL on success
  //   / no attempt. Raw provider error text MUST NEVER be written
  //   here — MAIL-5 writes only `MailerError.code`.
  lastEmailErrorCode: text('last_email_error_code'),
});

// ── Workspace Admin Integration tables ──────────────────────────

export const workspaceDomains = platformSchema.table('workspace_domains', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  hostname: text('hostname').notNull(),
  status: text('status').notNull().default('pending'),
  verificationMethod: text('verification_method').notNull().default('dns_txt'),
  verificationName: text('verification_name').notNull(),
  verificationValueHash: text('verification_value_hash').notNull(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
  // Phase B (workspace-domain-verification-ux): count-only diagnostic
  // populated by the verify handler. NEVER stores raw TXT record values.
  dnsRecordsFound: integer('dns_records_found'),
});

export const workspaceApiKeys = platformSchema.table('workspace_api_keys', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  name: text('name').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  keyHash: text('key_hash').notNull(),
  status: text('status').notNull().default('active'),
  presetKey: text('preset_key'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export const workspaceApiKeyScopes = platformSchema.table(
  'workspace_api_key_scopes',
  {
    apiKeyId: uuid('api_key_id').notNull(),
    actionKey: text('action_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.apiKeyId, t.actionKey] }),
  }),
);
