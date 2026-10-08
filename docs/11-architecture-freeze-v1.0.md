# Architecture Freeze V1.0

Status: APPROVED FOR PHASE 1 RUNTIME IMPLEMENTATION
Date: 2026-08-11

## Frozen Decisions
1. Offline-first with local SQLite as operational source of truth.
2. Event + projection data model.
3. Canonical qr_master identity for each physical unit.
4. Append-only production_events audit trail.
5. Outbox synchronization with idempotency, backoff, dead-letter, and restart recovery.
6. Internal event bus with versioned envelopes.
7. Clean Architecture with strict context boundaries and ports/adapters.
8. Supabase as cloud sync/analytics layer, not scan-time dependency.
9. Soft delete policy for mutable master records.
10. Immutable audit_log for critical actions.

## Remaining Technical Debt (Accepted)
- Local archival compaction policy implementation pending.
- RLS policies to be fully encoded and tested with role matrix.
- Full backup restore rehearsal automation pending.

## Remaining Risks (Actively Managed)
- Very high-scale analytics may require cloud-side partitioning and materialized views.
- Event contract drift risk if versioning policy is not enforced in CI.
- Operational drift risk if backup verification is not monitored.

## Guardrails for Phase 1
- No ad hoc architecture changes during implementation.
- Any cross-context contract change requires ADR update.
- Performance and reliability instrumentation must be included from first runtime slice.
- Migration scripts are mandatory for every schema change.
- Event payload changes require version bump and compatibility tests.

## Go/No-Go Criteria to Start Coding
- DDD map approved.
- Event catalog and envelope approved.
- Schema and migration policy approved.
- Operations and recovery policy approved.

Decision: GO.
