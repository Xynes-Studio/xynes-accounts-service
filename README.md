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
