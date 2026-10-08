# DDD Context Map (Architecture V1.0)

## Contexts and Ownership

### Production Context
Owns:
- Scanner intake rules
- QR parse/validate orchestration
- Production event creation
- Duplicate prevention policy

Writes:
- qr_master
- production_events
- sync_outbox

### Inventory Context
Owns:
- Stock projection logic
- Inventory valuation logic
- Low stock thresholds and alerts

Writes:
- stock_projection_by_variant
- stock_projection_by_location
- report_daily_summary
- sync_outbox

### Warehouse Context
Owns:
- Location movement rules
- Putaway, transfer, dispatch handoff

Writes:
- production_events (event_type MOVED, DISPATCHED)
- qr_master current_location
- stock projections
- sync_outbox

### Sales Context
Owns:
- Sale and return transitions
- Reservation and release policies

Writes:
- production_events (SOLD, RETURNED)
- qr_master current_status/current_location
- stock projections
- sync_outbox

### Purchasing Context
Owns:
- Supplier master integration points
- Receipt and inbound stock adjustments

Writes:
- production_events (ADJUSTMENT, MOVED)
- stock projections
- sync_outbox

### Dispatch Context
Owns:
- Packing and dispatch state transitions
- Vehicle/container assignment

Writes:
- production_events (PACKED, DISPATCHED)
- qr_master current_status/current_location
- sync_outbox

### Reporting Context
Owns:
- Aggregation models
- Trend calculations and report templates

Writes:
- report_daily_summary
- metrics_timeseries

### Authentication Context
Owns:
- User identity linkage
- Role assignment and permission evaluation

Writes:
- operators
- roles
- role_permissions

### Synchronization Context
Owns:
- Outbox processing
- Idempotency, retries, backoff, dead-letter handling

Writes:
- sync_outbox
- production_events.sync_status
- devices.last_sync_at

### Administration Context
Owns:
- Device registration
- Settings, backup policies, health snapshots

Writes:
- devices
- app_settings
- backup_history
- system_health_snapshots

## Context Interaction Rules
- Contexts interact using application events and published interfaces.
- No context can directly update another context's private invariants.
- Shared reference data is read-only from external contexts unless via explicit application service.

## Anti-Corruption Rules
- External providers (Supabase, future cloud vendors) are wrapped in ports/adapters.
- Payload mapping happens at boundary adapters, never inside domain entities.
