import { z } from 'zod';

export const pingPayloadSchema = z.object({}).strict();

export const readSelfUserPayloadSchema = z.object({}).strict();

export const readCurrentWorkspacePayloadSchema = z.object({}).strict();

export const ensureWorkspaceMemberPayloadSchema = z
  .object({
    role: z.enum(['member', 'admin']).optional(),
  })
  .strict();
