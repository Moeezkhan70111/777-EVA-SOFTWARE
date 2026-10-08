# Internal Event Bus and Event Versioning

## Event Bus Purpose
The event bus decouples modules and preserves extension flexibility.

Flow:
- Scanner frame accepted
- ProductionCompleted event published
- Inventory projection handler updates stock
- Reporting handler updates summaries
- Sync handler appends outbox entries
- UI refresh event emitted

## Delivery Semantics
- In-process bus for desktop runtime.
- At-least-once delivery to handlers.
- Handlers must be idempotent.
- Handler execution errors are isolated and logged.

## Event Envelope Standard
Every domain/application event uses:
- event_id
- event_type
- event_version
- correlation_id
- causation_id
- occurred_at
- actor_user_id
- actor_device_id
- payload

## Versioning Policy
- Additive changes: increment minor version and keep old fields valid.
- Breaking changes: publish new event version and support both versions during transition.
- Handlers declare supported versions explicitly.

## Core Event Catalog (V1)
- QrScannedRawReceived.v1
- QrValidationFailed.v1
- ProductionCompleted.v1
- DispatchCompleted.v1
- ReturnCompleted.v1
- StoreEntryCompleted.v1 — Store Scanning received a carton (PRODUCED/RETURNED/TO_GATE → WAREHOUSE); persisted as a MOVED production_event with metadata eventType STORE_ENTRY
- StoreExitCompleted.v1 — Store Move Out sent a carton to the gate, ready to be dispatched (WAREHOUSE → TO_GATE, location WAREHOUSE → GATE); persisted as a MOVED production_event with metadata eventType STORE_EXIT
- DuplicateScanRejected.v1
- StockProjectionUpdated.v1
- SyncQueued.v1
- SyncAttempted.v1
- SyncSucceeded.v1
- SyncFailed.v1
- HealthSnapshotCaptured.v1
- BackupCompleted.v1

## Persistence Rule
- Critical business events must be reflected in production_events and/or audit_log.
- Transient UI-only events are not persisted.
