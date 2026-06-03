/**
 * MAIL-4 — Barrel for `infra/secrets`. Re-exports the
 * `SecretManagerClient` port + `EnvSecretManagerClient` local-dev impl +
 * the closed-set `SecretManagerError`.
 */

export {
  EnvSecretManagerClient,
  SecretManagerError,
  parseSecretRef,
  secretPathToEnvPrefix,
  isSecretManagerError,
  type EnvSecretManagerClientDeps,
  type MailProviderCredentialMaterial,
  type SecretManagerClient,
  type SecretManagerErrorCode,
} from './SecretManagerClient';
