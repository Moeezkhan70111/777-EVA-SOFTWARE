# Architecture Design (Finalized Foundation)

## 1) Architectural Style
Use Clean Architecture with explicit bounded contexts.

Layers:
- Presentation Layer: desktop screens, scanner status UI, dashboards
- Application Layer: use-cases and orchestration
- Domain Layer: entities, invariants, policies, event contracts
- Infrastructure Layer: SQLite adapter, Supabase adapter, sync worker, device integrations

Primary rule:
- No UI component or infrastructure adapter may bypass application use-cases.

## 2) Bounded Contexts
- Manufacturing: scan intake, production events, QR lifecycle
- Inventory: stock projections, value calculations, adjustments
- Dispatch: transfer and shipment events
- Sales: reservation, sale, return events
- Master Data: products, factories, workstations, users
- Platform: auth, audit, notifications, settings

This prevents tight coupling and allows independent module growth.

## 3) Desktop Runtime Model
Recommendation: Electron + React + TypeScript.

Why this is optimal:
- Main process can safely own local DB and background workers.
- Renderer remains responsive and never blocks on sync/network.
- Packaging and device compatibility on Windows are proven at scale.

Process responsibilities:
- Main Process
  - scanner capture ingestion
  - application services
  - SQLite transactional writes
  - outbox worker and retry scheduler
- Renderer Process
  - operator workflow and status
  - dashboards and reports views
  - no direct database or network writes

## 4) Scanner Pipeline Contract
Scanner service must be storage-agnostic.

Responsibilities:
- listen to HID keystream input
- buffer until Enter
- detect and discard incomplete frames by timeout
- throttle noise from manual typing using scanner timing profile
- emit only complete raw scan frames to application layer

Non-responsibilities:
- no database access
- no sync logic
- no business decisions

Application-layer intake flow:
1. Receive raw scan frame.
2. Run version router and validation.
3. Parse to canonical QR payload.
4. Execute ProduceProduct use-case.
5. Return success/error result for UI and sound feedback.

## 5) Versioned QR Parser Architecture
Support multiple QR formats without rewrites.

Design:
- QrParserRegistry
  - ordered parser list, each parser exposes canParse() and parse()
- QrParserV1
  - format ARTICLE_COLOR_SIZE_SERIAL
- QrParserV2 (future)
  - format FACTORY_ARTICLE_COLOR_SIZE_BATCH_SERIAL
- Canonical output DTO
  - qr_id, article, color, size, serial, optional factory_code, optional batch

Rule:
- unknown format is rejected with structured error code and user-safe message.

## 6) Transaction Boundary (Critical)
Per successful scan, execute one atomic local transaction:
1. validate and parse QR
2. duplicate check by qr_id
3. ensure/create product variant
4. insert qr_master record
5. insert production event (immutable)
6. apply stock projection delta
7. append outbox item
8. commit

Failure policy:
- Any failure triggers rollback; no partial state.

## 7) Event and Projection Pattern
Adopt event sourcing principles where:
- production_events is immutable event log
- stock_projections are mutable read models optimized for speed
- report summary tables are pre-aggregated projections

This is the best long-term tradeoff between auditability and performance.

## 8) Dependency Inversion
Use ports/adapters for:
- ScannerPort
- ProductRepositoryPort
- QrMasterRepositoryPort
- ProductionEventRepositoryPort
- StockProjectionRepositoryPort
- OutboxRepositoryPort
- SyncGatewayPort

Benefits:
- testability
- vendor independence
- easier migration of DB/cloud providers later

## 9) Cross-Cutting Standards
- Structured logging with correlation_id per scan
- Centralized error taxonomy (validation, duplicate, db, sync)
- Config module with typed environment contract
- Audit trail for critical state changes
- Health checks: database integrity, pending queue depth, sync lag
