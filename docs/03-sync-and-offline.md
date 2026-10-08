# Offline-First and Synchronization Design (Finalized)

## Core Rule
Local SQLite commit is the only requirement for scan success.
Cloud state never gates scanning.

## Local Transaction per Scan
1. Validate + parse QR.
2. Check duplicate by qr_id.
3. Insert qr_master.
4. Insert production_events row.
5. Apply stock projection delta.
6. Insert one or more sync_outbox rows.
7. Commit.

If any step fails, rollback entire transaction.

## Outbox Pattern Details
Outbox row structure must include:
- aggregate_type
- aggregate_id
- operation
- payload_json
- dedupe_key

Idempotency key strategy:
- qr master insert: QR_MASTER:{qr_id}
- production event insert: PRODUCTION_EVENT:{event_id}
- projection upsert: PROJECTION:{projection_key}:{event_id}

## Worker Execution Model
- Single worker per local DB file.
- Lease rows by setting status IN_FLIGHT and lock token.
- Use small configurable batches.
- Commit status transitions in short transactions.

Startup recovery:
- On app start, reset stale IN_FLIGHT rows older than timeout back to PENDING.

## Retry and Backoff
- Exponential backoff with jitter.
- Max attempts threshold to move row into DEAD_LETTER state.
- Dead-letter entries remain visible for operator/admin recovery.

## Conflict and Idempotency Rules
- Cloud unique constraints enforce physical uniqueness.
- Upsert by unique business keys.
- If conflict indicates already processed logical duplicate, mark local row SYNCED.
- If payload mismatch for same key, mark FAILED and require operator review.

## Connectivity and Throttling
- Health probe interval is adaptive.
- Back-pressure: if queue depth exceeds threshold, lower batch frequency for UI safety.
- Scan pipeline remains fully independent of worker load.

## Realtime and Read Strategy
- Desktop dashboards read SQLite first.
- Supabase Realtime updates are for remote dashboards and other clients.
- Local client may subscribe for cross-device awareness but never for local correctness.
