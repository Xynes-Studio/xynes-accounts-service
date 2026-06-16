# Xynes Accounts Service – Developer Guide

Internal-only Accounts service. This service exposes **no public routes**.

## TL;DR

- Start dev server: `bun run dev`
- Run unit suite: `bun run test`
- Run lint: `bun run lint`
- Run coverage-gated suite (must be ≥ 80% funcs + lines): `bun run test:coverage`
- (Optional) Run DB integration tests: `bun run test:integration`

## Contract

### Health & Readiness (public, no auth)

- `GET /health` – Liveness probe + downstream dependency status (H-2; binding contract: [`xynes-infra/infra/release/HEALTHCHECK-CONTRACT.md`](../xynes-infra/infra/release/HEALTHCHECK-CONTRACT.md)).
  - 200 OK on the happy path; 503 when a critical dependency fails.
  - Response (always JSON, `application/json; charset=utf-8`):

    ```jsonc
    {
      "ok": true,
      "service": "xynes-accounts-service",
      "version": "v0.1.0",      // from XYNES_BUILD_VERSION env, falls back to "dev"
      "uptime_seconds": 1234,
      "checks": {
        "db": "ok",             // critical — flips top-level ok
        "authz": "skipped"      // non-critical (§4 rule 3) — does NOT flip ok
      }
    }
    ```

  - Auth: NONE. The endpoint must be reachable with no `Authorization`, no `X-Internal-Service-Token`, no cookies (it sits in front of the internal-service-auth middleware so Docker's `HEALTHCHECK` directive can probe inside the container).
  - Access log: SKIPPED. `src/app.ts` mounts `hono/logger` only on non-`/health` and non-`/ready` paths per HEALTHCHECK-CONTRACT.md §2.6.
  - Probes: `db` runs a `SELECT 1` against `DATABASE_URL` via `checkPostgresReadiness()` with a 1 s timeout per §2.5; `authz` is an optional one-hop `GET ${ACCOUNTS_HEALTH_AUTHZ_URL}` (also 1 s timeout). Both probes' failures are cached for 30 s to avoid retry storms per §4 cascade-avoidance rules.
  - Latency budget: ≤ 50 ms p95, ≤ 300 ms p99. Tests assert ≤ 200 ms with a generous margin for jsdom/CI variability.
  - Forbidden content: the body must NEVER contain `DATABASE_URL`, `JWT_SECRET`, raw API keys, stack traces, or any value that identifies a user or workspace. The handler catches probe errors and surfaces only the closed-set check value; regression-guarded by [`tests/health.unit.test.ts`](./tests/health.unit.test.ts) §7.8.
- `GET /ready` – Readiness probe (checks DB connectivity).
  - Success (200): `{ "status": "ready" }`
  - Failure (503): `{ "status": "not_ready", "error": "<message>" }`

### Internal Actions (requires auth)

- Endpoint: `POST /internal/accounts-actions`
- Requires internal auth header:
	- `X-Internal-Service-Token: <token>` (must match env `INTERNAL_SERVICE_TOKEN`)
- Trust boundary (gateway-owned headers):
	- `X-XS-User-Id` (UUID)
	- `X-Workspace-Id` (UUID) (required for workspace-scoped actions)
	- `X-XS-User-Email` (string)
	- `X-XS-User-Name` (string)
	- `X-XS-User-Avatar-Url` (string)
- **Actor recognition (PFU-1, 2026-05-08):** the gateway forwards an
  `X-XS-Actor-Type` header (`user` | `api_key`) plus, for `api_key`
  actors, `X-XS-API-Key-Id` (UUID) and `X-XS-API-Key-Prefix` (8 hex
  chars). When `actor=api_key`:
	- `X-XS-User-Id` is **not** required (API keys have no human user).
	- The handler context exposes `ctx.actor = { kind: "api_key",
	  apiKeyId, keyPrefix }`.
	- `requirePermission(...)` SHORT-CIRCUITS — the gateway has already
	  enforced scope against the route `actionKey` (see
	  `xynes-gateway/src/router/dynamicRouter.ts` Task 4). Re-running an
	  authz user check here would be a layering violation.
	- Handlers that record audit ownership (`createdBy`, `revokedBy`)
	  use `requireUserActor(ctx)` and reject `api_key` actors with
	  `FORBIDDEN_ACTOR_KIND` (403).
	- Handlers that are read-only use `requireAuthenticatedActor(ctx)`
	  to accept either actor kind.
	- If `X-XS-Actor-Type` is absent or set to `user`, the route still
	  requires `X-XS-User-Id` (legacy behaviour preserved byte-for-byte).
- Request envelope:
	- `{ actionKey: string, payload: unknown }`
- Response envelope:
	- Success: `{ ok: true, data: <T>, meta: { requestId } }`
	- Error: `{ ok: false, error: { code, message, details? }, meta: { requestId } }`

## Global Standards

- **Segregation**: HTTP orchestration lives in `src/routes/**`; domain behaviour lives in `src/actions/**`; infra adapters live in `src/infra/**`.
- **Security**: fail-closed internal auth, strict request validation, no trust in client-provided internal headers.
- **Testing**: TDD mandatory; test pyramid per ADR-001.
- **Coverage**: minimum **80%** funcs + lines enforced by `bun run test:coverage`.

Reference ADR: `xynes-cms-core/docs/adr/001-testing-strategy.md`.

## Folder Structure

- `src/app.ts`: Hono app wiring. Mounts `/health`, `/ready`, and `/internal`.
- `src/controllers/`: Controller logic (separated from routing)

  - `src/controllers/health.controller.ts`: Liveness check handler
  - `src/controllers/ready.controller.ts`: Readiness check handler (DB connectivity)
- `src/routes/`: HTTP routes (request/response + validation)

  - `src/routes/health.route.ts`: `GET /health` (liveness)
  - `src/routes/ready.route.ts`: `GET /ready` (readiness)
  - `src/routes/internal.route.ts`: `POST /internal/accounts-actions`
- `src/middleware/`: request-id, internal token auth, error handling
- `src/actions/`: internal action registry, schemas, handlers

  - `src/actions/register.ts`: action registration
  - `src/actions/schemas.ts`: strict Zod payload schemas
  - `src/actions/guards.ts`: shared context-validation and RBAC guard helpers (`requireUserId`, `requireWorkspaceId`, `requirePermission`, `requireUserActor`, `requireAuthenticatedActor`)
  - `src/actions/handlers/*`: action implementations
  - `src/actions/handlers/integrations/`: workspace admin integration utilities and handlers
    - `domainValidation.ts`: hostname normalization and validation for workspace verified domains
    - `apiKeyCrypto.ts`: API key generation, hashing (Argon2id), and verification
    - `domains.ts`: workspace domain CRUD action handlers (list, create, verify, soft-delete)
    - `apiKeys.ts`: workspace API key lifecycle handlers (list, create, revoke, usage.read) + preset-to-scope mapping
- `src/infra/`: config, logger, DB client, request parsing helpers
- `tests/`: unit and integration tests

  - `tests/*.unit.test.ts`: unit/contract tests (no DB)
  - `tests/*.integration.test.ts`: DB-backed tests (gated)

## Internal Actions

All behaviour is exposed via the internal “actions” endpoint.

### Supported action keys

- `accounts.ping` → payload `{}` → returns `{ pong: true }`
- `accounts.user.readSelf` → payload `{}` → returns `{ id, email, ... }` (DB)
- `accounts.user.updateSelf` → payload `{ displayName }` → returns `{ id, email, displayName, avatarUrl }` (DB)

	- Requires `X-XS-User-Id`
	- Does **not** require `X-Workspace-Id`
	- Payload is `z.strict()` (extra keys rejected)

- `accounts.workspace.readCurrent` → payload `{}` → returns `{ id, name, ... }` (DB)
- `accounts.workspaceMember.ensure` → payload `{ role?: "member" | "admin" }` → returns `{ created: boolean }` (DB)
- `accounts.me.getOrCreate` → payload `{}` → returns `{ user, workspaces }` (DB + authz role enrichment)

	- Requires `X-XS-User-Id` + `X-XS-User-Email`
	- Does **not** require `X-Workspace-Id`

- `accounts.workspaces.listForUser` → payload `{}` → returns `{ workspaces: Array<{ id, name, slug, planType, role }> }` (DB + authz role enrichment)

	- Requires `X-XS-User-Id`
	- Does **not** require `X-Workspace-Id`
	- Payload is `z.strict()` (extra keys rejected)

- `accounts.workspace_members.listForWorkspace` → payload `{}` → returns `{ members: Array<{ userId, email, displayName, avatarUrl, status, joinedAt, roleKey }> }` (DB)

	- Requires `X-XS-User-Id`
	- Requires `X-Workspace-Id`
	- RBAC enforced via authz `POST /authz/check` for `accounts.workspace_members.listForWorkspace`

- `accounts.workspaces.create` → payload `{ name, slug }` → returns `{ id, name, slug, planType, createdBy }` (DB)

	- Requires `X-XS-User-Id`
	- Does **not** require `X-Workspace-Id`
	- Assigns `workspace_owner` in authz via internal action `authz.assignRole`
	- If authz assignment fails and cleanup also fails, the workspace may be orphaned; see logs for `[WorkspacesCreate] Cleanup failed ...`

- `accounts.invites.create` → payload `{ email, roleKey }` → returns `{ id, workspaceId, email, roleKey, status, expiresAt, token }` (DB)

	- Requires `X-XS-User-Id` and `X-Workspace-Id`
	- Performs RBAC via authz `POST /authz/check` for `accounts.invites.create`
	- **BUG-AUTH-8 guards (run BEFORE token generation + invite insert):**
		- `SELF_INVITE` (HTTP 400, `DomainError.code = 'SELF_INVITE'`): rejects when the normalized invitee email matches the actor's own email. Prefer `ctx.user.email` (set by the gateway from the user JWT) and fall back to an `identity.users` lookup by `ctx.userId` when the gateway did not propagate the email.
		- `ALREADY_MEMBER` (HTTP 400, `DomainError.code = 'ALREADY_MEMBER'`): rejects when the invited address already has an `active` membership in this workspace. Resolved by a single workspace-scoped inner join of `platform.workspace_members` against `identity.users.email`. The error message NEVER leaks the existing member's userId / email / displayName.
	- Generates a cryptographically-random invite token and stores only a one-way hash in DB
	- The raw `token` is returned **once** to the caller (for sharing with the invitee)

- `accounts.invites.resolve` → payload `{ token }` → returns `{ id, workspaceId, workspaceSlug, workspaceName, inviterName, inviterEmail, inviteeEmail, role, roleKey, status, expiresAt, createdAt }` (DB)

	- **Public** action: does **not** require `X-XS-User-Id` or `X-Workspace-Id`
	- Looks up invites by hash(token); never stores raw tokens
	- If an invite is `pending` but already expired, it is marked `expired` best-effort (without leaking DB errors)

- `accounts.invites.accept` → payload `{ token }` → returns `{ accepted, workspaceId, roleKey, workspaceMemberCreated, workspace }` (DB)

	- Requires `X-XS-User-Id` (auth required); does **not** require `X-Workspace-Id`
	- Validates invite is `pending` and not expired/cancelled
	- Enforces invite email matches the authenticated user email from `identity.users`
	- Ensures membership exists and assigns the invite's `roleKey` via authz internal action `authz.assignRole`
	- On authz failure, performs best-effort rollback (revert invite status and remove newly-created membership)

- `platform.domains.list` → payload `{}` → returns `{ domains: Array<DomainDto> }` (DB)

	- Requires `X-XS-User-Id` (or any authenticated actor — see PFU-1) and `X-Workspace-Id`
	- RBAC enforced via authz `POST /authz/check` for `platform.domains.list`
	- Returns workspace domains; response never contains `verificationValueHash`
	- **Accepts `api_key` actor** (read-only).

- `platform.domains.create` → payload `{ hostname }` → returns `DomainDto & { verificationValue }` (DB)

	- Requires `X-XS-User-Id` and `X-Workspace-Id`
	- RBAC enforced via authz for `platform.domains.create`
	- Hostname is normalised and validated via `normalizeWorkspaceDomain`
	- Verification value shown **once** in response; only the SHA-256 hash is stored in DB
	- Returns CONFLICT (409) for duplicate active hostnames
	- **Rejects `api_key` actor** with `FORBIDDEN_ACTOR_KIND` (403) — domain creation records `createdBy`.

- `platform.domains.verify` → payload `{ domainId }` → returns `DomainDto` (DB + DNS)

	- Requires `X-XS-User-Id` and `X-Workspace-Id`
	- RBAC enforced via authz for `platform.domains.verify`
	- Performs DNS TXT record lookup against the stored verification name
	- Updates `lastCheckedAt`, `status`, `verifiedAt`/`failureCode` based on DNS result
	- **Rejects `api_key` actor** with `FORBIDDEN_ACTOR_KIND` (403) — DNS verification is a privileged human-driven workflow.

- `platform.domains.delete` → payload `{ domainId }` → returns `DomainDto` (DB)

	- Requires `X-XS-User-Id` and `X-Workspace-Id`
	- RBAC enforced via authz for `platform.domains.delete`
	- **Soft-delete only**: sets `status = 'disabled'` to preserve audit history
	- Does NOT physically remove the row from `platform.workspace_domains`
	- **Rejects `api_key` actor** with `FORBIDDEN_ACTOR_KIND` (403).

- `platform.api_keys.list` → payload `{}` → returns `{ apiKeys: Array<ApiKeyDto> }` (DB)

	- Requires `X-XS-User-Id` (or any authenticated actor — see PFU-1) and `X-Workspace-Id`
	- RBAC enforced via authz `POST /authz/check` for `platform.api_keys.list`
	- Returns workspace API keys; response never contains `keyHash` or the raw key
	- **Accepts `api_key` actor** (read-only). The `workspace_admin` preset includes this scope.

- `platform.api_keys.create` → payload `{ name, presetKey, expiresAt? }` → returns `ApiKeyDto & { rawKey, scopes }` (DB)

	- Requires `X-XS-User-Id` and `X-Workspace-Id`
	- RBAC enforced via authz for `platform.api_keys.create`
	- `presetKey` maps to a curated set of action-key scopes (see `WORKSPACE_API_KEY_PRESETS`)
	- Raw key shown **once** in response; only Argon2id hash + 8-char prefix stored in DB
	- Returns INVALID_PRESET (400) for unknown preset keys
	- Returns HTTP 201 on success
	- **Rejects `api_key` actor** with `FORBIDDEN_ACTOR_KIND` (403) — privilege escalation guard. The MVP `workspace_admin` preset deliberately omits this scope; this branch is defense-in-depth.

- `platform.api_keys.revoke` → payload `{ keyId }` → returns `ApiKeyDto` (DB)

	- Requires `X-XS-User-Id` and `X-Workspace-Id`
	- RBAC enforced via authz for `platform.api_keys.revoke`
	- Sets `status = 'revoked'`, records `revokedBy` (userId) and `revokedAt`
	- Returns ALREADY_REVOKED (409) if key is already revoked
	- Does NOT physically delete the row from `platform.workspace_api_keys`
	- **Rejects `api_key` actor** with `FORBIDDEN_ACTOR_KIND` (403) — privilege escalation guard.

- `platform.api_keys.usage.read` → payload `{ keyId }` → returns `{ keyId, name, status, lastUsedAt, createdAt, scopes }` (DB)

	- Requires `X-XS-User-Id` (or any authenticated actor — see PFU-1) and `X-Workspace-Id`
	- RBAC enforced via authz for `platform.api_keys.usage.read`
	- Returns key metadata + last usage timestamp + associated scopes
	- Response never contains `keyHash` or raw key
	- **Accepts `api_key` actor** (read-only). The `workspace_admin` preset includes this scope.

### Adding a new action (TDD workflow)

Follow ADR-001 order (schema tests → unit logic tests → integration flow test):

1. Add a strict payload schema in `src/actions/schemas.ts`.
2. Implement a handler in `src/actions/handlers/`.
	 - Prefer DI-friendly factories if the handler touches DB or external systems.
3. Register the action in `src/actions/register.ts`.
4. Update the route switch in `src/routes/internal.route.ts` to validate the payload.
5. Add/extend unit tests in `tests/internal_actions.unit.test.ts`.
6. If DB-backed, add an integration test in `tests/*.integration.test.ts` and run with `bun run test:integration`.

## Security Notes

- Internal auth is mandatory for every `/internal/*` request.
- Headers `X-XS-User-Id` and `X-Workspace-Id` are validated as UUIDs.
- JSON request bodies are size-limited via `MAX_JSON_BODY_BYTES` (default 1 MiB).
- Payload schemas are `z.strict()` to prevent accidental over-posting.

### Workspace invite tokens

- Tokens are **bearer secrets**. Treat them like passwords.
- The database stores only a **SHA-256 hash** of the token (never the raw token).
- Public resolve does not echo tokens in error messages.

### Workspace API keys

- API keys are **bearer secrets**. Raw keys are shown **once** at creation time, then discarded.
- The database stores only an **Argon2id hash** (`key_hash`) and a short **prefix** (`key_prefix`) for indexed lookup.
- `key_prefix` is the first 8 hex chars of the secret portion — safe for display but not enough to reconstruct the key.
- The raw key format is `xynes_live_<64-hex-chars>` (32 bytes CSPRNG entropy).
- Never log raw API keys. The handler layer must scrub raw keys from response metadata/logs.

## Integration Utilities

Shared utilities for the workspace admin integrations epic live in `src/actions/handlers/integrations/`.

These are **pure utility modules** — no DB, no HTTP, no side-effects. Downstream action handlers (Tasks 5-6 in the implementation plan) compose them.

### Domain Validation (`domainValidation.ts`)

Normalises and validates raw hostname input for workspace verified domains.

**Exports:**

```ts
type NormalizedDomain = {
  hostname: string;         // Lower-cased, trimmed (e.g. "example.com")
  verificationName: string; // DNS TXT record name (e.g. "_xynes.example.com")
};

function normalizeWorkspaceDomain(input: string): NormalizedDomain;
```

**Validation rules (in execution order):**

| # | Rule | Example rejected |
|---|------|------------------|
| 1 | Trim + lowercase | `"  Example.COM  "` → `"example.com"` |
| 2 | Empty string | `""`, `"   "` |
| 3 | IPv4 / IPv6 literals | `"192.168.1.1"`, `"::1"`, `"[::1]"` |
| 4 | Forbidden chars: `://`, `/`, `?`, `#`, `:`, `*` | `"https://x.com"`, `"x.com/blog"`, `"x.com:8080"` |
| 5 | Reserved hostnames | `"localhost"` |
| 6 | Must contain at least one dot | `"intranet"` |
| 7 | No leading/trailing dots | `".example.com"`, `"example.com."` |
| 8 | RFC 1035: ≤ 253 total, ≤ 63 per label | `"aaa...aaa.com"` (> 253) |

Throws `DomainError` with code `INVALID_DOMAIN` (HTTP 400) on any violation.

**Usage example:**

```ts
import { normalizeWorkspaceDomain } from './integrations/domainValidation';

const { hostname, verificationName } = normalizeWorkspaceDomain('Example.com');
// hostname = "example.com"
// verificationName = "_xynes.example.com"
```

### API Key Crypto (`apiKeyCrypto.ts`)

Generates, hashes, and verifies workspace API keys using cryptographically secure primitives.

**Exports:**

```ts
type GeneratedWorkspaceApiKey = {
  rawKey: string;    // "xynes_live_<64-hex>" — show once, never store
  keyPrefix: string; // First 8 hex chars of secret — safe for DB index/display
  keyHash: string;   // Argon2id hash — safe to store in DB
};

async function generateWorkspaceApiKey(): Promise<GeneratedWorkspaceApiKey>;
async function hashWorkspaceApiKey(rawKey: string): Promise<string>;
async function verifyWorkspaceApiKey(rawKey: string, keyHash: string): Promise<boolean>;
```

**Security properties:**

| Property | Implementation |
|----------|----------------|
| Randomness | `crypto.randomBytes` (CSPRNG), 32 bytes |
| Hash algorithm | Argon2id (via `Bun.password`) |
| Memory cost | 19,456 KiB (~19 MiB) — OWASP minimum |
| Time cost | 2 iterations |
| Salt | Auto-generated per hash (unique each call) |
| Prefix safety | 8 hex chars (4 bytes) — insufficient to reconstruct 32-byte key |
| Error handling | `verifyWorkspaceApiKey` returns `false` (never throws) on malformed inputs |

**Usage example:**

```ts
import {
  generateWorkspaceApiKey,
  verifyWorkspaceApiKey,
} from './integrations/apiKeyCrypto';

// At creation time (show rawKey to user once)
const { rawKey, keyPrefix, keyHash } = await generateWorkspaceApiKey();
// Store keyPrefix + keyHash in DB; return rawKey in create response only

// At verification time (e.g. API gateway)
const isValid = await verifyWorkspaceApiKey(incomingRawKey, storedHash);
```

**Test coverage:** Both modules are at **100% function and line coverage**.

### API Key Action Handlers (`apiKeys.ts`)

Workspace API key lifecycle handlers (CRUD + usage read) with built-in RBAC and preset-to-scope mapping.

**Handler factories (DI-friendly):**

| Factory | Action Key | Description |
|---------|-----------|-------------|
| `createListApiKeysHandler` | `platform.api_keys.list` | Lists all API keys for the workspace (never leaks `keyHash`) |
| `createCreateApiKeyHandler` | `platform.api_keys.create` | Creates a key, maps preset to scopes, returns raw key once |
| `createRevokeApiKeyHandler` | `platform.api_keys.revoke` | Soft-revokes a key (records `revokedBy`/`revokedAt`) |
| `createReadApiKeyUsageHandler` | `platform.api_keys.usage.read` | Returns key metadata + `lastUsedAt` + associated scopes |

**Preset → scope mapping (`WORKSPACE_API_KEY_PRESETS`):**

| Preset Key | Scopes |
|-----------|--------|
| `cms_readonly` | `cms.content.listPublished`, `cms.content.getPublishedBySlug`, `cms.blog_entry.listPublished`, `cms.blog_entry.getPublishedBySlug` |
| `cms_authoring` | `cms.entry.create`, `cms.entry.update`, `cms.entry.getById`, `cms.entry.listByDirectory` |
| `cms_publisher` | All `cms_authoring` scopes + `cms.entry.publish`, `cms.entry.status.set` |
| `telemetry_read` | `telemetry.events.listRecentForWorkspace`, `telemetry.stats.summaryByRoute` |
| `workspace_admin` | `platform.domains.list`, `platform.api_keys.list`, `platform.api_keys.usage.read` |

> **Security:** `workspace_admin` intentionally excludes `platform.api_keys.create` and `platform.api_keys.revoke` to prevent privilege escalation via API key self-management.

> **Cross-package contract (PFU-6):** the *keys* of `WORKSPACE_API_KEY_PRESETS` are the canonical workspace API key preset keys. The canonical list is owned by `@xynes/platform-contracts` (`WORKSPACE_API_KEY_PRESET_KEYS` in `xynes/xynes-platform-contracts/src/integrations/api-key-presets.ts`). The preset → scope *mapping* itself is intentionally server-only because it encodes authz wiring; only the key set is shared. Parity is enforced by `apiKeyPresets.contract.test.ts`. Adding a new preset:
> 1. Append the key to `WORKSPACE_API_KEY_PRESET_KEYS` in `@xynes/platform-contracts`.
> 2. Add the preset → scope mapping in this service's `WORKSPACE_API_KEY_PRESETS`.
> 3. Mirror the new key in each consumer's local copy (the contract tests will fail until you do).

**Test coverage:** `apiKeys.ts` — 100% functions, 99.51% lines (37 unit tests).

### Shared Action Guards (`guards.ts`)

Reusable context-validation and RBAC helpers extracted to eliminate duplication across handler files.

**Exports:**

```ts
function requireUserId(ctx: ActionContext): string;
function requireWorkspaceId(ctx: ActionContext): string;
async function requirePermission(authzClient: AuthzClient, ctx: ActionContext, actionKey: string): Promise<void>;
function resolveAuthzClient(injected?: AuthzClient): AuthzClient;
```

**Test coverage:** 100% functions, 100% lines.

## Mail Dispatch (MAIL-2)

Vendor-neutral mailer abstraction for workspace-invite delivery. Source: `src/infra/mail/`.

This module ships the **port + local-dev implementation + DI plumbing only**. The actual invocation of `mailer.sendInvite(...)` from `accounts.invites.create` lands in MAIL-5, alongside the new `accounts.invites.resend` action.

### Public surface

```ts
import {
  MailerClient,                   // port interface
  SendInviteInput,
  SendInviteResult,
  MailerError,                    // closed-set error class
  MailerErrorCode,
  isMailerError,
  StubMailerClient,               // local-dev implementation (stdout / SMTP relay)
  noopMailer,                     // frozen no-op default
} from '../infra/mail';
```

### Closed-set error codes (`MailerError`)

| Code                     | statusHint | retryable | Surfaced when                                                         |
|--------------------------|-----------:|:---------:|-----------------------------------------------------------------------|
| `RECIPIENT_INVALID`      | 400        | no        | The `to` field failed validation, or the SMTP relay returned 550/553. |
| `PROVIDER_UNAVAILABLE`   | 503        | yes       | TCP connect failure, read timeout, transient 4xx, or unknown error.   |
| `RATE_LIMITED`           | 429        | yes       | The provider rejected the send because of a quota.                    |
| `TEMPLATE_RENDER_FAILED` | 500        | no        | Required template fields are missing or empty.                        |
| `PROVIDER_REJECTED`      | 502        | no        | Permanent provider rejection that is not the recipient itself.        |

The `message` field is a fixed, sanitised string per code — implementations MUST NOT interpolate upstream provider error text into it. Use the optional `diagnosticTag` for log correlation; the tag is never concatenated into `message`.

### `StubMailerClient` modes

- **`{ mode: 'stdout' }`** — writes a single JSON line per dispatch via the configured `stdoutSink` (default `console.log`). The full invite token NEVER appears; the URL is masked through `maskInviteUrl` to `***<last8>`. PII minimisation: `inviterName` is intentionally NOT included in the JSON record.

- **`{ mode: 'smtp_relay', relayUrl, fromAddress }`** — connects over plain SMTP to the configured relay (typically `smtp://127.0.0.1:54325` for the MAIL-1 Inbucket inbox). Speaks the minimal handshake (banner → EHLO → MAIL FROM → RCPT TO → DATA → body → QUIT) via a hand-rolled transport over `Bun.connect`. **No nodemailer dependency.** No TLS, no AUTH — local-dev only. Hosted environments use `ResendMailerClient` (MAIL-4) over HTTP.

Header injection is prevented by sanitising CR/LF/TAB out of every header field value before composing the SMTP DATA block — a hostile `workspaceName` cannot add a `Bcc:` header.

### DI hook in `accounts.invites.create`

`CreateWorkspaceInviteDependencies` now carries an optional `mailer?: MailerClient`. MAIL-2 wires the TYPE only — the runtime code path in `create.ts` is unchanged. MAIL-5 will:

1. Destructure `mailer = noopMailer` in the closure.
2. After the existing `dbClient.insert(workspaceInvites)...`, branch on `ctx.actor?.kind`:
   - `'api_key'` → skip dispatch entirely (Story C parity).
   - `'user'` → call `await mailer.sendInvite({...})` inside try/catch.
3. On success, bump `email_sent_at` + `email_attempts`.
4. On `MailerError`, log the closed-set code (NOT the raw error) and write `last_email_error_code`.

This split lets MAIL-2 land without changing the 270-test accounts-service baseline.

### Test coverage

| File                                      | Funcs   | Lines   |
|-------------------------------------------|--------:|--------:|
| `src/infra/mail/MailerError.ts`           | 100%    | 100%    |
| `src/infra/mail/MailerClient.ts`          | n/a (types only) | n/a |
| `src/infra/mail/noopMailer.ts`            | 100%    | 100%    |
| `src/infra/mail/inviteUrlMask.ts`         | 100%    | 100%    |
| `src/infra/mail/StubMailerClient.ts`      | 100%    | 100%    |
| `src/infra/mail/smtpTransport.ts`         | 95%     | 98.56%  |

Tests live under `tests/unit/mail/` and include an in-process SMTP server (`smtpTransport.integration.test.ts`) that exercises the production `defaultSmtpDispatcher` against `Bun.listen` so the full handshake state machine is covered without depending on a live Inbucket.

## Mailer Dispatch State Columns (MAIL-3)

Three additive columns on `platform.workspace_invites` capture mailer dispatch state for MAIL-5's runtime wiring and `accounts.invites.resend` rate-limit cap.

| Column                   | Type              | NULL?    | Default | Purpose                                                                                                  |
|--------------------------|-------------------|----------|---------|----------------------------------------------------------------------------------------------------------|
| `email_sent_at`          | `timestamptz`     | nullable | NULL    | Timestamp of the most recent **successful** `mailer.sendInvite` return. NULL = "no successful send yet". |
| `email_attempts`         | `integer`         | NOT NULL | `0`     | Total dispatch attempts (success + failure). MAIL-5 bumps atomically via `email_attempts + 1`.           |
| `last_email_error_code`  | `text` (closed)   | nullable | NULL    | Closed-set `MailerErrorCode` (see MAIL-2 table above) or NULL on success / no attempt.                   |

### Source of truth

- **Canonical migration:** `xynes/xynes-infra/supabase/migrations/20260601090000_workspace_invites_mail_columns.sql` — additive `ADD COLUMN IF NOT EXISTS` for all three; nullable / NOT NULL DEFAULT 0 semantics enforce backwards compat for pre-MAIL-3 rows.
- **Drizzle mirror:** `src/infra/db/schema.ts` `workspaceInvites` block — `emailSentAt`, `emailAttempts`, `lastEmailErrorCode`. Camel-case TS names map to the snake-case SQL column names via Drizzle's first-argument string contract; the schema-mirror test at `tests/unit/workspace-invites-mail-columns.test.ts` regression-guards the mapping.

### MAIL-5 write contract (preview — not landed yet)

The columns are wired but **not written from any runtime path** in MAIL-3. MAIL-5 will introduce the writes:

```ts
// On successful dispatch (mailer.sendInvite resolves cleanly):
await db.update(workspaceInvites)
  .set({
    emailSentAt: new Date(),
    emailAttempts: sql`${workspaceInvites.emailAttempts} + 1`,
    lastEmailErrorCode: null,
  })
  .where(eq(workspaceInvites.id, inviteId));

// On MailerError (or any thrown):
await db.update(workspaceInvites)
  .set({
    emailAttempts: sql`${workspaceInvites.emailAttempts} + 1`,
    lastEmailErrorCode: error.code,  // closed-set MailerErrorCode only
    // emailSentAt deliberately NOT touched
  })
  .where(eq(workspaceInvites.id, inviteId));
```

**Security contract:** MAIL-5's write path MUST only write the closed-set `MailerError.code` value to `last_email_error_code`. Raw provider error text NEVER reaches this column. The DB column is `text` (not a CHECK enum) so the enforcement is at the handler layer — MAIL-2's `MailerError` class is the gate.

### Backwards compatibility

- Pre-MAIL-3 invite rows auto-populate to `email_sent_at = NULL`, `email_attempts = 0`, `last_email_error_code = NULL` — matching the documented "no dispatch attempted" state.
- Old-replica rolling deploys: pre-MAIL-3 code paths never reference these columns, so the NOT NULL DEFAULT / nullable settings auto-populate on INSERT.
- `accounts.invites.create` return shape unchanged — MAIL-5 will record dispatch state via a separate UPDATE inside the handler, not by extending the return DTO.

### Tests added by MAIL-3

| File                                                | Tests | Coverage gate           |
|-----------------------------------------------------|------:|-------------------------|
| `tests/unit/workspace-invites-mail-columns.test.ts` | 9     | `schema.ts` 100% / 100% |

The companion contract test on the canonical migration lives in `xynes-infra` at `scripts/test/workspace-invites-mail-columns.test.sh` (40 / 0 PASS — additive-only invariants, fail-closed defaults, plan reference, no-raw-credentials sweep). Both tests run automatically — the Bun unit test joins the 355-test baseline; the infra shell test is glob-discovered by `xynes-infra/scripts/test/run.sh`.

## Resend Mailer + Secret Manager (MAIL-4)

MAIL-4 ships the hosted-mode mailer (`ResendMailerClient`), the vendor-neutral `SecretManagerClient` interface (mirrored from STORAGE-FU-3 per plan §13 Q1), and the env-driven composition helper (`resolveMailerFromEnv`). Runtime wiring into the `accounts.invites.create` handler and the new `accounts.invites.resend` action remain MAIL-5 scope.

### Source layout

```
src/infra/
├── mail/
│   ├── ResendMailerClient.ts     (NEW — hosted HTTP POST to Resend API)
│   ├── resolveMailerFromEnv.ts   (NEW — composition helper)
│   └── index.ts                  (extended barrel re-exporting MAIL-4)
└── secrets/                       (NEW — secret-manager interface)
    ├── SecretManagerClient.ts
    └── index.ts
```

### `ResendMailerClient` contract

Hosted `MailerClient` implementation. Reaches Resend via `POST https://api.resend.com/emails` with a Bearer API key. Key material is held in a **non-enumerable** instance property (`Object.defineProperty(..., { enumerable: false })`) so `JSON.stringify(client)` cannot leak it. Provider error response bodies are **never** concatenated into the surfaced `MailerError.message` — the closed-set HTTP-status → `MailerErrorCode` mapping is the only signal that escapes the boundary.

**Closed-set HTTP status mapping:**

| Resend HTTP | `MailerErrorCode`        | Retryable? |
|------------:|--------------------------|:----------:|
| 422         | `RECIPIENT_INVALID`      | no         |
| 400         | `PROVIDER_REJECTED`      | no         |
| 401 / 403   | `PROVIDER_REJECTED`      | no         |
| 429         | `RATE_LIMITED`           | yes        |
| 5xx         | `PROVIDER_UNAVAILABLE`   | yes        |
| Network throw / timeout / abort | `PROVIDER_UNAVAILABLE` | yes |

Construction validates the API key shape (`re_` prefix + ≥ 8-char tail) and the `fromAddress` (non-empty, email-looking). Misconfiguration surfaces as `TEMPLATE_RENDER_FAILED` at construction — defense in depth against placeholder env values like `replace-with-actual-key`.

### `SecretManagerClient` interface

Vendor-neutral contract for resolving `MAIL_RESEND_SECRET_REF` (a `secret://<path>` URI) to mail-provider credentials. Mirrors the storage-service `STORAGE-FU-3` interface byte-for-byte on URI parsing rules + closed-set `SecretManagerErrorCode` (`NOT_FOUND` / `BACKEND_UNAVAILABLE` / `MATERIAL_INVALID` / `URI_INVALID`).

Local-dev impl (`EnvSecretManagerClient`) reads `MAIL_CREDENTIAL_<UPPERCASE_PATH>_API_KEY` + `MAIL_CREDENTIAL_<UPPERCASE_PATH>_FROM_ADDRESS` from `process.env`. The env prefix uses an **injective** encoding (`/` → `__`, `-` → `_`, underscores forbidden in the path) so two distinct credential refs can never collide on the same env block.

**Per plan §13 Q1:** option (b) — copy a minimal interface into `accounts-service/src/infra/secrets/`. A future shared-contract extraction into `xynes-platform-contracts` (option (a)) will deduplicate the storage-service mirror.

### `resolveMailerFromEnv` decision matrix

```
MAIL_PROVIDER=resend  +  MAIL_RESEND_SECRET_REF set  →  ResendMailerClient
                      +  resolver throws            →  throws closed-set MailerError
MAIL_PROVIDER=stub    +  SMTP_RELAY_URL set         →  StubMailerClient (smtp_relay)
MAIL_PROVIDER=stub    +  SMTP_RELAY_URL unset       →  StubMailerClient (stdout)
MAIL_PROVIDER=noop                                   →  noopMailer (DI default)
MAIL_PROVIDER unset / malformed                      →  noopMailer  (fail-open)
```

**Fail-open default** for unknown / unset `MAIL_PROVIDER` matches CMS-API-KEY-ACTOR-1 Story C's "best-effort cleanup" posture: the invite row still lands; only the side effect is skipped.

### Env contract

| Var                          | Default | Required when                    | Purpose                                                                                                            |
|------------------------------|---------|----------------------------------|--------------------------------------------------------------------------------------------------------------------|
| `MAIL_PROVIDER`              | unset   | always (else falls back to noop) | `resend` \| `stub` \| `noop`. Case-insensitive; trimmed.                                                            |
| `MAIL_RESEND_SECRET_REF`     | unset   | `MAIL_PROVIDER=resend`           | `secret://<path>` URI. Resolved through `SecretManagerClient`.                                                     |
| `SMTP_RELAY_URL`             | unset   | optional                         | When `MAIL_PROVIDER=stub`, picks `smtp_relay` mode (`smtp://127.0.0.1:54325` for the MAIL-1 Inbucket inbox).        |
| `MAIL_STUB_FROM_ADDRESS`     | `no-reply@xynes.local` | optional         | Bound `from` for the stub when `smtp_relay` mode is active.                                                        |
| `MAIL_CREDENTIAL_<P>_API_KEY` | unset  | local-dev `EnvSecretManagerClient` | Raw Resend key for the `<P>` path component. **Never committed.**                                                  |
| `MAIL_CREDENTIAL_<P>_FROM_ADDRESS` | unset | local-dev `EnvSecretManagerClient` | Sender address for the `<P>` path component.                                                                       |

**NEVER commit a raw `re_<key>` value to any tracked file.** The `EnvSecretManagerClient` is a local-dev-only backend; hosted environments wire AWS Secrets Manager / Doppler / Vault implementations of the same interface in their composition root (each is a separate per-environment story per plan §13 Q1).

### Security invariants (proven by tests)

1. **Bearer API key NEVER leaves the `Authorization` header.** Stored as a non-enumerable instance property; `JSON.stringify(client)` produces a tiny object that does not carry the key. Tests assert the key is absent from every URL / body / serialised form.
2. **Resend response body bytes NEVER appear in any `MailerError`.** A hostile 401 response containing `AKIA-LEAK-1234 X-Amz-Signature=DEADBEEF re_LEAK_5678 xynes_live_abc` is asserted not to leak ANY of those substrings into the thrown error message.
3. **Pre-validation runs BEFORE any `fetch` call.** Malformed recipient / blank template fields surface as closed-set errors with `fetch` call count 0.
4. **CR/LF/TAB sanitised** out of every header-bound field before composing the subject + plaintext body — defense in depth on top of Resend's own sanitization.
5. **Log redaction extension:** `src/infra/log-redaction.ts` now scrubs `re_[A-Za-z0-9_-]{8,}` substrings as `[REDACTED:RESEND_API_KEY]` AND drops fields named `resendApiKey` / `resend_api_key` / `resend-api-key`. Public `messageId` audit handle is preserved.

### Tests added by MAIL-4

| File                                              | Tests | Coverage |
|---------------------------------------------------|------:|----------|
| `tests/unit/secrets/SecretManagerClient.test.ts`  | 31    | 100% / 100% |
| `tests/unit/mail/ResendMailerClient.test.ts`      | 44    | 92.31% / 99.33% |
| `tests/unit/mail/resolveMailerFromEnv.test.ts`    | 25    | 100% / 98.67% |
| `tests/unit/log-redaction.test.ts` (MAIL-4 block) | +11   | 100% / 97.22% |

**+111 net new tests** (suite 355 → 466). Overall coverage 89.99% funcs / 91.95% lines (above ADR-001 80% floor).

### Companion redaction extensions in `xynes-gateway`

MAIL-4 extends the gateway's existing redaction stack so a hostile downstream response carrying a raw Resend key cannot leak into access-log snippets or telemetry:

- `src/telemetry/types.ts` — new `RAW_RESEND_KEY_REDACTION_PATTERN` (`re_[A-Za-z0-9_-]{8,}`); `resendapikey` + `resend_api_key` added to `FORBIDDEN_TELEMETRY_FIELDS`.
- `src/telemetry/sanitize.ts` — `truncateUserAgent` applies both `xynes_live_*` AND `re_*` redactions.
- `src/logging/redaction.ts` — `SENSITIVE_TEXT_PATTERN` extended with the `re_*` arm. The existing `apikey` field-name substring tier already covers `resendApiKey` / `resend_api_key` / `resend-api-key` — verified by dedicated tests.

## Invite-mail dispatch + Resend action (MAIL-5)

MAIL-5 is the runtime wiring story: it connects the MAIL-2 / MAIL-3 / MAIL-4 building blocks to the actual `accounts.invites.create` handler and ships the new `accounts.invites.resend` action.

### `accounts.invites.create` — best-effort mailer dispatch

`src/actions/handlers/invites/create.ts` now performs a best-effort `mailer.sendInvite(...)` call after the invite row insert. The dispatch is **fire-and-forget** from the handler's point of view:

- A thrown `MailerError` (or any other error) NEVER undoes the row insert.
- The closed-set `MailerError.code` is written to `last_email_error_code` (MAIL-3 column) so an operator can re-dispatch via the new `accounts.invites.resend` action later.
- The `accounts.invites.create` return shape is preserved byte-for-byte (the row insert + raw token surface stays unchanged).

Skip gates (both deliberate, both keep the legacy 270-test pre-MAIL-5 baseline passing):

- `mailer === noopMailer` — the production composition root must explicitly inject a non-noop mailer (or call `resolveMailerFromEnv()`). Until then, dispatch is silently skipped — same behaviour as the pre-MAIL-2 code path.
- `ctx.actor?.kind === 'api_key'` — CMS-API-KEY-ACTOR-1 Story C parity. The invite row still lands; only the mailer side effect is short-circuited (machine credentials should not trigger user-facing emails).

### `accounts.invites.resend` — re-dispatch with token rotation

`src/actions/handlers/invites/resend.ts` is a new action handler that re-dispatches the invitation email for a still-pending invite row. It is registered under the action key `accounts.invites.resend` and wired through the gateway at `POST /workspaces/:workspaceId/invites/:inviteId/resend`.

**Design note — token rotation.** The DB stores only the hash of the invite token (see `inviteToken.ts`); the raw token is shown ONCE at create time. Two designs were considered: (A) require the caller to supply the raw token in the payload (matches the plan §9.4 "no token regenerated" line but pushes raw tokens into client memory long after `create`), or (B) generate a fresh token pair, store the new hash, dispatch the new URL (matches plan §3 "no raw token persistence" and the §9.2 `{ inviteId: string }` payload shape, but contradicts §9.4).

**We chose (B).** Rationale:

- §3 ("no raw token persistence") is the stronger constraint — design (A) would force the auth-app to retain the raw token in memory or session storage, defeating the hash-only DB invariant.
- Invalidating the old emailed link on resend is a security positive — a leaked/forwarded old link cannot be used after the operator clicks Resend.
- The new token uses the SAME `expiresAt` as the original — resend does NOT extend the lifetime. To extend the window, the operator must create a fresh invite.
- The token rotation + dispatch-state UPDATE land in a single atomic SQL UPDATE so a crash between them cannot leave the row in an inconsistent state.

**Payload + return shape**:

| Field | Type | Notes |
|---|---|---|
| `inviteId` | uuid | Payload — the invite to resend. |
| `inviteId` (response) | uuid | Echo of the input. |
| `emailAttempts` | int | Post-bump value of the MAIL-3 counter. |
| `emailSentAt` | iso8601 \| null | Stamped on success; null on failure or never-sent. |
| `lastEmailErrorCode` | `MailerErrorCode` \| null | Closed set; null on success. |

**Rate-limit**: `MAIL_RESEND_MAX_ATTEMPTS` env var (default 5). When `email_attempts >= cap`, the handler throws `429 RATE_LIMITED` WITHOUT rotating the token or invoking the mailer. Operators tune the cap per environment.

**Guard rails (closed set):**

- `MISSING_CONTEXT` (400) — `ctx.workspaceId` missing.
- `FORBIDDEN_ACTOR_KIND` (403) — `ctx.actor?.kind === 'api_key'`. Defense-in-depth; the gateway also blocks api_key actors because the action is not in any MVP API-key preset.
- `UNAUTHORIZED` (401) — `ctx.userId` missing.
- `FORBIDDEN` (403) — authz check failed.
- `NOT_FOUND` (404) — invite row missing OR `invite.workspaceId !== ctx.workspaceId` (cross-workspace probes use the same envelope as truly-unknown ids — no enumeration oracle).
- `INVALID_STATE` (409) — invite status is not `pending`.
- `GONE` (410) — invite expiresAt has passed.
- `RATE_LIMITED` (429) — `email_attempts >= MAIL_RESEND_MAX_ATTEMPTS`.

### Env contract additions

- `INVITE_BASE_URL` (optional) — base URL for composing the invite link (`${INVITE_BASE_URL}/invite/${token}`). Defaults to `http://localhost:3100` for local-dev parity with the auth-app's host port. Trailing slashes are stripped so `https://app.xynes.com/` and `https://app.xynes.com` are equivalent.
- `MAIL_RESEND_MAX_ATTEMPTS` (optional) — lifetime resend-attempt cap per invite row. Default 5. Beyond the cap, `accounts.invites.resend` returns 429 without invoking the mailer or rotating the token.

### Tests added by MAIL-5

| File | Tests | Per-file coverage (funcs / lines) |
|---|------:|---|
| `tests/unit/mail/create-mail-dispatch.test.ts` | 13 | covers `resolveInviteBaseUrl` + the dispatch block in `create.ts` |
| `tests/unit/mail/resend.test.ts` | 23 | covers the full resend handler matrix |

Plus a one-line update to the obsolete `tests/unit/mail/create-mailer-di.test.ts` test name (the MAIL-2 "does NOT call mailer" assertion was replaced with the MAIL-5 noopMailer short-circuit assertion).

### Security invariants (proven by tests)

1. **Raw token never appears in DB UPDATEs.** Both `create.ts` and `resend.ts` UPDATE patches are swept per-field for the raw token literal — the token only lives in the `inviteUrl` passed to the mailer.
2. **api_key actors never trigger mail.** Both handlers gate on `ctx.actor?.kind === 'api_key'` (create skips silently; resend hard-fails with 403 `FORBIDDEN_ACTOR_KIND`).
3. **Closed-set error codes only.** `MailerError.code` is the only value written to `last_email_error_code`; non-MailerError exceptions are bucketed as `PROVIDER_UNAVAILABLE`. Raw provider error text NEVER reaches the column.
4. **Token rotation is atomic with dispatch state.** A single SQL UPDATE rotates `token` AND updates the MAIL-3 columns — a crash between the two cannot leave the row inconsistent.
5. **Cross-workspace probes return NOT_FOUND.** The resend handler filters by both `id` AND `workspaceId`; a caller targeting another workspace's invite gets the same envelope as a truly-unknown id (no enumeration oracle).
6. **Rate-limit cap blocks both dispatch AND token rotation.** When the cap is hit, `RATE_LIMITED` (429) is thrown BEFORE the token factory runs — so old links continue to work until the operator creates a fresh invite.

### Operator notes

- Local-dev: set `MAIL_PROVIDER=stub` + `SMTP_RELAY_URL=smtp://127.0.0.1:54325` to dispatch via Inbucket (MAIL-1 inbox). Open `http://127.0.0.1:54324` to read the dispatched mail.
- Hosted: set `MAIL_PROVIDER=resend` + `MAIL_RESEND_SECRET_REF=secret://xynes/mail/resend-<env>` and wire a real `SecretManagerClient` implementation in the composition root.
- When `MAIL_PROVIDER` is unset OR malformed, `resolveMailerFromEnv()` returns `noopMailer` — the invite row lands but no mail is dispatched. Set the env var deliberately in every deployment.

## Environment

Scripts use `.env.dev` by default (Docker/dev). For local host runs, override:

- Docker/dev: `.env.dev`
- Local host: `XYNES_ENV_FILE=.env.localhost`

Required env vars:

- `PORT`
- `DATABASE_URL`
- `INTERNAL_SERVICE_TOKEN`
- `AUTHZ_SERVICE_URL` (used for workspace role assignment)
- `AUTHZ_CLIENT_TIMEOUT_MS` (optional; default 5000)
- `MAX_JSON_BODY_BYTES`

## Database (via SSH tunnel)

DB connectivity is expected via the shared SSH tunnel (local port 5432).

For the canonical host/user and current instructions, see:

`xynes-infra/infra/SSH_TUNNEL_SUPABASE_DB.md`

Notes:

- In Docker, `db.local` resolves to your host (see `xynes-infra/docker-compose.dev.yml` `extra_hosts`).
- For local host runs, `DATABASE_URL` typically points at `127.0.0.1:5432`.

## Docker Dev Stack

The dev compose stack lives in `xynes-infra/docker-compose.dev.yml`.

- `accounts-service` is **internal-only** (uses `expose`, not `ports`).
- Gateway calls it via `ACCOUNTS_SERVICE_URL=http://accounts-service:<port>`.

## Testing (TDD + Coverage)

- Unit tests must not touch real DB/network.
- Integration tests are gated behind `RUN_INTEGRATION_TESTS=true`.
- Coverage gate enforces ≥ 80% funcs + lines:

  - `bun run test:coverage`

Common commands:

- `bun run test`
- `bun run test:coverage`
- `bun run test:integration`

## Linting

- `bun run lint`
- `bun run lint:fix`

## Production Dockerfile (H-2)

Multi-stage layout cloned from the H-1 pioneer recipe — see
[`xynes-infra/docs/plans/2026-05-13-mvp-release-stories/group-H-dockerfile-prod-targets.md`](../xynes-infra/docs/plans/2026-05-13-mvp-release-stories/group-H-dockerfile-prod-targets.md)
§"Landed implementation notes (2026-06-15)" for the deviation rationale.

### Stages

- **`base`** — pinned `oven/bun:1-alpine` by manifest-list digest (matches the H-1 lockstep digest). Shared install context.
- **`dev`** — bind-mount-friendly target for the local `docker-compose.dev.yml` stack. Bun watch mode.
- **`prod`** — hardened runtime: non-root `xynes` user (uid 1001), production-only deps, no test/docs payload, no `.env*` files. `HEALTHCHECK` directive wired against `/health` per [`HEALTHCHECK-CONTRACT.md`](../xynes-infra/infra/release/HEALTHCHECK-CONTRACT.md) §5.

### Build & smoke commands

```bash
# Build prod image
docker buildx build --target prod -t xynesplatform/xynes-accounts-service:test --load .

# Verify image properties
docker image inspect xynesplatform/xynes-accounts-service:test --format '{{.Config.User}}'              # → xynes
docker image inspect xynesplatform/xynes-accounts-service:test --format '{{json .Config.Healthcheck}}'  # → CMD-SHELL bun run healthcheck
docker image inspect xynesplatform/xynes-accounts-service:test --format '{{.Size}}'                     # → < 200 MB

# Live smoke (needs DATABASE_URL reachable; example uses local Supabase)
docker run -d --name h2-smoke --rm \
  -e PORT=4203 \
  -e DATABASE_URL='postgres://postgres:postgres@host.docker.internal:5432/postgres' \
  -e XYNES_BUILD_VERSION='h2-test' \
  -e INTERNAL_SERVICE_TOKEN='dummy' \
  -p 4203:4203 \
  xynesplatform/xynes-accounts-service:test
sleep 8
curl -s http://127.0.0.1:4203/health | jq .
docker inspect --format '{{.State.Health.Status}}' h2-smoke   # → healthy
docker stop h2-smoke
```

### Environment variables (production runtime)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | yes | `4203` | Container listen port. |
| `DATABASE_URL` | yes | — | Postgres connection string for `platform`/`identity` schemas. |
| `XYNES_BUILD_VERSION` | recommended | `dev` | Surfaces in `/health.version`. Set to the image tag or `sha-<7>` at build time. |
| `ACCOUNTS_HEALTH_AUTHZ_URL` | no | — | Optional authz `/health` URL for the one-hop probe (e.g. `http://authz-service:4300/health`). When unset, `/health.checks.authz` reports `"skipped"`. **MUST** point at the authz service directly, NOT the gateway (§4 rule 1 forbids transitive probes). |
| `INTERNAL_SERVICE_TOKEN` | yes | — | Required by the internal-actions middleware; never used by `/health` or `/ready`. |
| `JWT_SECRET` | yes | — | Used by `src/infra/security/internal-jwt.ts` for inviting/workspace JWTs; never used by `/health` or `/ready`. |

### Deviations from the canonical group-H skeleton (locked by H-1)

1. **Base image is `oven/bun:1-alpine`** (not `oven/bun:1` debian-slim). Debian lands the prod image at ~253 MB, blowing the < 200 MB story budget; alpine lands at ~140 MB. Bun's binary is statically linked, so musl libc vs glibc is a no-op for our workload.
2. **No `build` stage.** xynes-accounts-service runs `src/index.ts` directly through Bun's TS support. The `prod` stage installs full deps (verifies `bun.lock`), discards them, reinstalls `--production`, and copies `src/` + `scripts/` + `drizzle/` + `package.json` + `bun.lock` + `tsconfig.json` + `drizzle.config.ts`. The TypeScript correctness gate runs in CI (group-M).
3. **Healthcheck uses `bun -e 'fetch(...)'`** instead of `curl`, so the image needs no extra `apk add curl` layer.

### `.dockerignore`

See [`./.dockerignore`](./.dockerignore). Defense-in-depth list — the prod stage uses explicit `COPY src ./src` etc., so anything we forget here that we never `COPY` is already invisible to the prod image.

### CVE waivers

5 HIGH findings (4 inherited from H-1 + 1 drizzle-orm). All documented in [`./CVE-WAIVERS.md`](./CVE-WAIVERS.md) with rationale, remediation path, and tracking IDs (`H-1-FU-2`, `H-1-FU-3`, `H-2-FU-1`).
