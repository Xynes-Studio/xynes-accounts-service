-- Enforce workspace slug uniqueness at the DB layer.
-- Note: multiple NULL slugs are allowed by Postgres unique indexes.

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_unique_idx
  ON platform.workspaces (slug);
