import { pgSchema, uuid, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';

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
});
