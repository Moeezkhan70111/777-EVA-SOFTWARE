# Final Architecture Review Before Further Features

## What Was Improved
1. Added explicit QR lifecycle model via qr_master.
2. Generalized immutable events to support full ERP flows (not only Produced).
3. Added location-aware stock projections for future warehouses.
4. Strengthened outbox model with lease lock, dead-letter, and idempotency keys.
5. Added operator/device attribution for auditability and accountability.
6. Defined architecture gate before new feature implementation.

## Why These Choices Are Optimal
- Event + projection model provides both strong audit history and high dashboard performance.
- QR master as canonical unit identity avoids redesign when dispatch/sales/returns are introduced.
- Strict duplicate protection at use-case + DB + cloud levels minimizes production risk.
- Outbox with idempotency and retries is the most resilient pattern for multi-day offline operation.
- Local-first dashboard reads guarantee continued operations during internet failures.

## Known Weaknesses and Residual Risks
1. Global HID capture behavior can vary by OS focus/security context.
2. Large local SQLite files over years require retention/archival policies.
3. Device clocks can drift and affect event timestamps.
4. RLS policy quality determines cloud-side data isolation strength.
5. Dead-letter queue handling requires operator workflow and admin tools.

## Recommended Enhancements
1. Add NTP clock drift monitor and timestamp confidence flags.
2. Add periodic local DB VACUUM/backup maintenance job.
3. Add data retention strategy for old local events with safe archival.
4. Add signed event payload hash for tamper-evidence.
5. Add sync observability dashboard (lag, throughput, failure categories).
6. Add migration contract tests between SQLite schema and Supabase schema.

## Architecture Finalization Checklist
- Offline scan path is fully independent from cloud availability.
- No direct UI-to-database bypass; use-case boundary enforced.
- Duplicate prevention enforced in all layers.
- Event log immutable and projection tables query-optimized.
- Sync outbox idempotent and restart-safe.
- Schema includes factory/workstation/operator/device dimensions for ERP growth.

## Decision
Architecture is suitable as a long-term Manufacturing ERP foundation and is ready for controlled feature implementation in modules.
