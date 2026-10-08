# Migration and Release Governance

## Migration Policy
- Never alter production schema manually.
- All schema changes must be migration files committed to source control.
- Every migration must include:
  - forward script
  - rollback script (or explicit non-reversible rationale)
  - data backfill strategy if required

## Naming Convention
- 001_initial_schema
- 002_add_projection_tables
- 003_add_operator_and_device
- 004_add_reporting_summary
- 005_add_audit_and_health

## Deployment Order
1. Run local SQLite migration chain.
2. Run Supabase migration chain.
3. Run migration verification tests.
4. Enable feature flags that depend on new schema.

## Compatibility Rules
- New code must be backward compatible with previous schema for one release window.
- Breaking schema changes require dual-write or dual-read transition plan.

## Change Control
- Architectural change request required for cross-context schema impact.
- Update ER diagrams and event catalog in same pull request.
