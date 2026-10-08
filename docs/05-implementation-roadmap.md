# Implementation Roadmap

## Phase 0: Architecture Finalization Gate
- Finalize event model, QR master lifecycle, and projection strategy.
- Freeze table contracts and migration versioning policy.
- Define error taxonomy and observability baseline.
- Approve security baseline (RLS model, auth assumptions, secrets policy).

Exit criteria:
- design docs and schemas are internally consistent and versioned.

## Phase 1: Scanner Intake + Local Persistence
- Scanner HID frame collector and parser-router contract.
- QR V1 strict validator and canonical payload mapping.
- SQLite migrations and transaction script hardening.
- Atomic write path: qr_master + production_events + stock projection + outbox.
- Duplicate rejection UX and error audio hooks.

Deliverable: fully offline scanner with zero cloud dependency.

## Phase 2: Cloud Sync
- Supabase auth flow for desktop users.
- Outbox worker lease/retry/backoff/dead-letter.
- Idempotent upsert semantics and conflict policy.
- Sync health UI: pending count, retry count, dead-letter count.

Deliverable: auto sync with no duplicates and recovery after offline periods.

## Phase 3: Product Master + Inventory Metrics
- Product master management UI.
- Stock dashboards by article/color/size/location.
- Inventory value calculations (cost/selling/profit potential).

## Phase 4: Reporting
- Daily/weekly/monthly/yearly and trend analytics.
- Hourly production and top/least products.
- Precomputed summary projection refresh jobs.
- Export APIs for Excel/PDF.

## Phase 5: ERP Expansion
- Inventory movements, dispatch, returns.
- Purchase, warehouse transfer, quality checks.
- Sales and warehouse modules.
- Role-based permissions and audit trails.
- Multi-factory analytics dashboard.

## Engineering Standards
- Clean architecture boundaries.
- Dependency inversion for services and repositories.
- Unit tests on parsing/validation/use-cases.
- Integration tests for DB transactions and sync idempotency.
- Load tests for sustained high scan rates.
- Recovery tests for crash during transaction and crash during sync.
- Structured logs for scanner, DB, and sync traces.
