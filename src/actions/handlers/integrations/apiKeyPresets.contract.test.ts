import { describe, it, expect } from 'bun:test';
import { WORKSPACE_API_KEY_PRESETS } from './apiKeys';

/**
 * PFU-6 — Workspace API key preset keys: cross-package contract test.
 *
 * Source of truth: `xynes/xynes-platform-contracts/src/integrations/api-key-presets.ts`
 * (`WORKSPACE_API_KEY_PRESET_KEYS`).
 *
 * The platform-contracts package owns the canonical list. This service keeps
 * a local copy because it also needs the preset → action-key scope mapping
 * (`WORKSPACE_API_KEY_PRESETS`), which is server-only authz wiring and
 * intentionally not part of the cross-package contract.
 *
 * This test asserts the local copy's *keys* match the canonical contract.
 * The canonical list is duplicated inline below — that is intentional. If
 * the canonical list ever changes, this assertion is the trip-wire that
 * forces a deliberate update on this side too.
 *
 * Invariants enforced:
 *  1. The set of keys in `WORKSPACE_API_KEY_PRESETS` exactly matches the
 *     canonical list.
 *  2. Order matches the canonical list (UI parity — the create-API-key
 *     Select renders in this order).
 *  3. No accidental duplicates.
 *  4. Each key is a safe URL-query-parameter-friendly identifier.
 */

// Canonical contract — mirror of `WORKSPACE_API_KEY_PRESET_KEYS` from
// `@xynes/platform-contracts`. Update both together.
const CANONICAL_PRESET_KEYS = [
  'cms_readonly',
  'cms_authoring',
  'cms_publisher',
  'telemetry_read',
  'workspace_admin',
] as const;

describe('PFU-6 — WORKSPACE_API_KEY_PRESETS keys ↔ platform-contracts', () => {
  it('exposes exactly the canonical preset keys (order-sensitive)', () => {
    expect(Object.keys(WORKSPACE_API_KEY_PRESETS)).toEqual([...CANONICAL_PRESET_KEYS]);
  });

  it('exposes exactly the canonical preset keys (set equality)', () => {
    expect(Object.keys(WORKSPACE_API_KEY_PRESETS).sort()).toEqual(
      [...CANONICAL_PRESET_KEYS].sort(),
    );
  });

  it('contains no duplicate keys', () => {
    const keys = Object.keys(WORKSPACE_API_KEY_PRESETS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses only URL-query-parameter-friendly identifiers', () => {
    // Defense in depth — these keys flow into `?preset=<key>` deep links
    // built by the CMS console. Any path separator, whitespace, or
    // URL-reserved character would break the link.
    const validKey = /^[a-z][a-z0-9_]*$/;
    for (const key of Object.keys(WORKSPACE_API_KEY_PRESETS)) {
      expect(key).toMatch(validKey);
    }
  });

  it('every preset maps to at least one action-key scope', () => {
    // Server-only invariant: a preset with no scopes would silently mint
    // useless keys. The cross-package contract list does not encode this,
    // but this service is the one place where the invariant is checkable,
    // so we assert it here.
    for (const key of Object.keys(
      WORKSPACE_API_KEY_PRESETS,
    ) as (keyof typeof WORKSPACE_API_KEY_PRESETS)[]) {
      const scopes = WORKSPACE_API_KEY_PRESETS[key];
      expect(Array.isArray(scopes)).toBe(true);
      expect(scopes.length).toBeGreaterThan(0);
    }
  });
});

describe('Publisher capability inheritance', () => {
  it('has exactly all published reads, draft authoring and publication actions', () => {
    const actual: string[] = [...WORKSPACE_API_KEY_PRESETS.cms_publisher];
    expect(actual.sort()).toEqual(
      [
        'cms.content.listPublished',
        'cms.content.getPublishedBySlug',
        'cms.blog_entry.listPublished',
        'cms.blog_entry.getPublishedBySlug',
        'cms.delivery.listByDirectory',
        'cms.delivery.getById',
        'cms.entry.create',
        'cms.entry.update',
        'cms.entry.getById',
        'cms.entry.listByDirectory',
        'cms.entry.publish',
        'cms.entry.status.set',
      ].sort(),
    );
  });
  it('never grants key lifecycle, directory, collaboration, docs, storage or telemetry rights', () => {
    for (const scopes of Object.values(WORKSPACE_API_KEY_PRESETS)) {
      expect(new Set(scopes).size).toBe(scopes.length);
    }
    expect(
      WORKSPACE_API_KEY_PRESETS.cms_publisher.some((scope) =>
        [
          'platform.',
          'docs.',
          'storage.',
          'telemetry.',
          'cms.content_directories.',
          'cms.entry.collaborators.',
          'cms.entry.share.',
        ].some((prefix) => scope.startsWith(prefix)),
      ),
    ).toBe(false);
  });
});

describe('Approved Authoring capability inheritance', () => {
  it('has exactly all published reads and four draft authoring actions without publication or admin powers', () => {
    const expected = [
      'cms.content.listPublished',
      'cms.content.getPublishedBySlug',
      'cms.blog_entry.listPublished',
      'cms.blog_entry.getPublishedBySlug',
      'cms.delivery.listByDirectory',
      'cms.delivery.getById',
      'cms.entry.create',
      'cms.entry.update',
      'cms.entry.getById',
      'cms.entry.listByDirectory',
    ];
    const actual: string[] = [...WORKSPACE_API_KEY_PRESETS.cms_authoring];
    expect(actual.sort()).toEqual(expected.sort());
    expect(new Set(WORKSPACE_API_KEY_PRESETS.cms_authoring).size).toBe(10);
    const forbidden = [
      'cms.entry.publish',
      'cms.entry.status.set',
      'cms.entry.delete',
      'platform.api_keys.create',
      'platform.api_keys.revoke',
    ];
    for (const action of forbidden)
      expect(WORKSPACE_API_KEY_PRESETS.cms_authoring).not.toContain(action);
  });
});
