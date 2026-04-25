import { z } from 'zod';

const noControlChars = (value: string) => !/[\p{C}]/u.test(value);

export const pingPayloadSchema = z.object({}).strict();

export const readSelfUserPayloadSchema = z.object({}).strict();

export const updateSelfUserPayloadSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(noControlChars, 'displayName contains invalid control characters'),
  })
  .strict();

export const readCurrentWorkspacePayloadSchema = z.object({}).strict();

export const meGetOrCreatePayloadSchema = z.object({}).strict();

export const ensureWorkspaceMemberPayloadSchema = z
  .object({
    role: z.enum(['member', 'admin']).optional(),
  })
  .strict();

export const listWorkspacesForUserPayloadSchema = z.object({}).strict();

export const listWorkspaceMembersPayloadSchema = z.object({}).strict();

export const createWorkspacePayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, {
        message: 'slug must be 3-63 chars, lowercase, alphanumeric/dash, no leading/trailing dash',
      }),
  })
  .strict();

export const createWorkspaceInvitePayloadSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    roleKey: z.string().trim().min(1).max(128),
  })
  .strict();

export const resolveWorkspaceInvitePayloadSchema = z
  .object({
    token: z.string().trim().min(32).max(512),
  })
  .passthrough();

export const acceptWorkspaceInvitePayloadSchema = z
  .object({
    token: z.string().trim().min(32).max(512),
  })
  .passthrough();

// ── Platform Domain Action Schemas ──────────────────────────────

export const platformDomainsListPayloadSchema = z.object({}).strict();

export const platformDomainsCreatePayloadSchema = z
  .object({
    hostname: z.string().min(1).max(253),
  })
  .strict();

export const platformDomainsVerifyPayloadSchema = z
  .object({
    domainId: z.string().uuid(),
  })
  .strict();

export const platformDomainsDeletePayloadSchema = z
  .object({
    domainId: z.string().uuid(),
  })
  .strict();

// ── Platform API Key Action Schemas ─────────────────────────────

export const platformApiKeysListPayloadSchema = z.object({}).strict();

export const platformApiKeysCreatePayloadSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine(noControlChars, 'name contains invalid control characters'),
    presetKey: z.enum([
      'cms_readonly',
      'cms_authoring',
      'cms_publisher',
      'telemetry_read',
      'workspace_admin',
    ]),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const platformApiKeysRevokePayloadSchema = z
  .object({
    keyId: z.string().uuid(),
  })
  .strict();

export const platformApiKeysUsageReadPayloadSchema = z
  .object({
    keyId: z.string().uuid(),
  })
  .strict();
