# xynes-accounts-service

Internal-only Accounts service.

## Contract

- Only internal endpoint: `POST /internal/accounts-actions`
- Requires `X-Internal-Service-Token`
- Trust boundary: only trusts gateway-provided `X-XS-User-Id` and `X-Workspace-Id`.

## Local development


Database connectivity is expected via the shared SSH tunnel:


### Workspace Invites (INVITES-CORE-1)

See `DEVELOPER.md` for the action keys and security contract (token hashing, public resolve, authenticated accept).
`ssh -N -L 5432:127.0.0.1:5432 xynes@84.247.176.134`

## Scripts

- `bun run dev`
- `bun run test`
- `bun run test:coverage` (enforces 80% funcs/lines minimum)


## XYN-SEC-003 internal request boundary

Accounts actions accept only gateway Ed25519 request identities. Authz calls use the separate accounts identity, preserving the initiating actor/request id for privileged calls.
The signed context binds issuer/key id, audience, method, path/query, exact body,
action, workspace, actor metadata and request id. Tokens expire within 60 seconds.
Shared JWT/static credentials are rejected on protected action endpoints even in
hybrid mode. Missing/invalid identity files fail closed; no database migration is
required. Provision files before deploying the three updated services together.

Gateway/accounts callers use `INTERNAL_REQUEST_PRIVATE_KEY_FILE` and
`INTERNAL_REQUEST_KEY_ID`. Accounts/authz receivers use
`INTERNAL_REQUEST_TRUST_FILE` (JSON array of issuer, keyId and SPKI publicKey).
Never put private PEM values in shared env or receiver trust files. The canonical
provisioning/rotation/stage runbook is the sibling infra repository's
`infra/release/INTERNAL-REQUEST-IDENTITIES.md`; dev Compose owns individual mounts
and QA/Prod can apply `infra/compose/internal-request-identities.yml` last.

Internal API errors: missing token 401, untrusted caller or changed context 403,
misconfigured identity 500. Existing payload validation and body limits remain.
Protocol mirrors must remain identical across gateway/accounts/authz; infra
`scripts/test/sec003-identities.test.sh` enforces parity. Negative protocol tests
and the three-service tenant fixture accompany the change. Exact retries within
token lifetime use existing operation idempotency; no global replay cache exists.

SEC-003-FU-1 tracks other services' legacy internal credentials and CMS/docs'
isolated read-only `POST /authz/check` compatibility adapter. That adapter cannot
assign or list roles. Broader service migration is not part of this closure.
