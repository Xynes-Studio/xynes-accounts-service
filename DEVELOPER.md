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

- `GET /health` – Liveness probe (always returns 200 if service is running)
  - Response: `{ "status": "ok", "service": "xynes-accounts-service" }`
- `GET /ready` – Readiness probe (checks DB connectivity)
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
  - `src/actions/handlers/*`: action implementations
  - `src/actions/handlers/integrations/`: workspace admin integration utilities
    - `domainValidation.ts`: hostname normalization and validation for workspace verified domains
    - `apiKeyCrypto.ts`: API key generation, hashing (Argon2id), and verification
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
