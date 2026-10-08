# Risks, Mitigations, and Scaling

## Critical Risks

1. Scanner noise mixed with manual keyboard typing
- Mitigation: scanner timing heuristic, prefix/suffix guard options, frame timeout, and strict parser rejection.

2. Duplicate unit lifecycle corruption
- Mitigation: duplicate checks in use-case, unique constraint in SQLite, unique constraint in Supabase, idempotent sync keys.

3. Partial writes under crash/power loss
- Mitigation: single transaction write path, SQLite WAL mode, startup integrity checks, automatic backup rotation.

4. Outbox backlog after multi-day offline operation
- Mitigation: adaptive batching, backoff with jitter, dead-letter state, queue monitoring alerts.

5. Inconsistent operator/device attribution
- Mitigation: mandatory workstation/device identifiers and optional operator capture with audit defaults.

6. Security drift as modules grow
- Mitigation: role-based policy model now (factory scope + module permissions), periodic policy review and migration tests.

7. Cloud policy misconfiguration
- Mitigation: deny-by-default RLS, policy-as-code migration reviews, integration tests for unauthorized access.

8. Reporting latency at high volume
- Mitigation: maintain summary projections, indexed event queries, scheduled aggregate refresh.

## Residual Risks to Monitor
- Very large local DB files on long-lived devices.
- Clock skew causing incorrect local timestamps.
- Operator bypass attempts (manual DB edits or binary tampering).

## Scaling Guidance
- Keep immutable event tables and mutable projections separate.
- Add cloud partitioning for production_events by event_date at scale.
- Introduce archival strategy by closed periods.
- Add read replicas/materialized views for heavy remote analytics.

## Multi-Factory and Multi-Warehouse Readiness
- Carry factory_id on all operational records.
- Add location dimension projections now to avoid later redesign.
- Model permissions by scope: organization -> factory -> warehouse.
