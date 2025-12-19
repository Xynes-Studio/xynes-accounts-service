# Developer Notes

This service follows the same internal-actions pattern as other Xynes internal services:

- internal service token middleware
- action registry/dispatcher
- strict Zod payload schemas
- standard response envelope

Testing follows ADR-001 (TDD + pyramid): unit tests (no DB), integration tests (DB) gated by `RUN_INTEGRATION_TESTS=true`.
