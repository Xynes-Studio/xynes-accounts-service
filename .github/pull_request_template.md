## Summary
<!-- One-paragraph description of what this PR does and why. -->

## Linked work
- Plan / issue: <!-- link -->
- Related repos: <!-- link any PRs that depend on or are depended on by this one -->

## Quality gates
- [ ] `lint` passes locally
- [ ] `test` passes locally
- [ ] Coverage ≥ ADR-001 80% floor (or justified exception below)
- [ ] `typecheck` / `build` passes (where applicable)
- [ ] Docs updated (`README.md`, `DEVELOPER.md`, `AGENTS.md`, repo memory)
- [ ] Migration added (if schema change) — forward-only, expand/contract
- [ ] QA PII scrub updated (if migration adds PII)
- [ ] Release doc set updated (if release contract changed)

## Security
- [ ] No secrets in code, logs, error messages, or test fixtures
- [ ] No raw API keys forwarded to downstream services
- [ ] No PII added to telemetry or access logs

## Deployment notes
<!-- e.g. "Requires migration run before service rollout", "Requires xynes-platform-contracts vX.Y.Z first". -->

## Rollback plan
<!-- For risky changes only. -->

---

## Repo-specific items (xynes-accounts-service)

This is a **Bun + Hono + Drizzle** service. Use `bun`, never `npm`.

- [ ] Lint: `bun run lint` (eslint over `src/**/*.{ts,tsx}` + `tests/**/*.{ts,tsx}`)
- [ ] Tests: `bun run test` (unit suite; default env file `.env.dev` via `scripts/run-with-env.ts`)
- [ ] Integration tests (when touching DB-bound code): `bun run test:integration`
- [ ] Coverage: `bun run test:coverage` — overall must stay at or above the **ADR-001 80% lines + branches floor** (gated by `scripts/test-coverage-gate.ts`)
- [ ] Typecheck: `bun x tsc --noEmit` — zero new errors vs the target branch baseline (verify with `git stash` round-trip if pre-existing errors exist)
- [ ] If touching `src/infra/db/schema.ts`: add the matching forward-only Drizzle migration under `drizzle/`. Schema mirror MUST stay in sync with the canonical Supabase migrations owned by `xynes-infra/supabase/migrations/` (`platform.*` tables are co-owned; see `xynes-infra/docs/DATABASE.md` §5). Run `bun run migrate` against a local DB to verify replay-safety.
- [ ] **Actor-aware handlers (PFU-1 + CMS-API-KEY-ACTOR-1 Story C parity).** Handlers that mutate state and record audit ownership MUST gate with `requireUserActor(ctx)` from `src/actions/guards.ts`. Read-only handlers in the MVP `workspace_admin` preset (`platform.domains.list`, `platform.api_keys.list`, `platform.api_keys.usage.read`) MUST gate with `requireAuthenticatedActor(ctx)`. New action handlers MUST register a Zod `.strict()` payload schema in `src/actions/schemas.ts` and wire into the action switch in `src/routes/internal.route.ts`.
- [ ] **Closed-set error codes only.** Provider error text (Resend, Supabase, postgres, Argon2) MUST NOT propagate into envelope `error.message` or `error.details`. New error paths land as additions to the existing closed-set unions (e.g. `MailerErrorCode`, `SecretManagerErrorCode`) — never a free-form string.
- [ ] **No raw credentials.** API key material (Argon2id hash only — never the raw `xynes_live_*` token), invite tokens (hash only), and mailer API keys (`re_*`) are all resolver-only or hash-only. PRs adding a new credential surface MUST extend `log-redaction.ts` with the regex pattern + field-name allowlist.
- [ ] **No raw API keys forwarded downstream.** If proxying to another service, forward only the actor surface (`X-XS-Actor-Type`, `X-XS-User-Id` OR `X-XS-API-Key-Id` + `X-XS-API-Key-Prefix`, `X-Workspace-Id`) — never an `Authorization: Bearer xynes_live_*` header.
- [ ] If adding a new gateway-reachable action: open the matching `xynes-infra/supabase/migrations/20251229100001_seed_platform_routes.sql` route seed PR AND the `xynes-authz-service` permission catalog PR in lockstep. Merge order: contracts/authz first, then this PR.
