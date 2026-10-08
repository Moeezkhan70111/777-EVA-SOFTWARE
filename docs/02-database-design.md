# Database Design (ERP-Ready, Offline-First)

## Design Goals
- immutable audit trail
- strict duplicate prevention
- fast local dashboards without event-table scans
- schema stability for future ERP modules

## Modeling Approach
Use event + projection strategy:
- authoritative history: immutable events
- operational speed: mutable projections
- cloud sync durability: outbox

## Local SQLite Tables

### factories
- id (text PK)
- code (text unique)
- name
- timezone
- is_active
- created_at

### workstations
- id (text PK)
- factory_id (FK -> factories.id)
- workstation_code (text unique)
- device_id (text unique, machine fingerprint)
- name
- is_active
- created_at

### operators
- id (text PK)
- external_auth_id (nullable for future auth bridge)
- display_name
- role_code
- is_active
- created_at

### product_variants (Product Master)
- id (text PK)
- article
- color
- size
- description (nullable)
- cost_price (nullable)
- selling_price (nullable)
- status
- created_at
- updated_at
- unique(article, color, size)

### qr_master (one row per physical QR)
- qr_id (text PK, exact scanned value)
- product_variant_id (FK -> product_variants.id)
- current_status (PRODUCED|WAREHOUSE|DISPATCHED|SOLD|RETURNED|DAMAGED|SCRAPPED)
- current_location_type (FACTORY|WAREHOUSE|VEHICLE|CUSTOMER|UNKNOWN)
- current_location_id (nullable)
- first_event_id (FK -> production_events.id, nullable until event insert completes)
- created_at
- updated_at

Purpose:
- central lifecycle state for each unit across future modules.

### production_events (immutable)
- id (text PK)
- qr_id (FK -> qr_master.qr_id)
- product_variant_id (FK -> product_variants.id)
- event_type (PRODUCED|MOVED|PACKED|DISPATCHED|RETURNED|DAMAGED|SOLD|ADJUSTMENT)
- event_ts_local (text)
- event_date (text)
- event_hour (0-23)
- factory_id (FK -> factories.id)
- workstation_id (FK -> workstations.id)
- operator_id (nullable FK -> operators.id)
- device_id (text)
- article_snapshot
- color_snapshot
- size_snapshot
- serial_snapshot
- metadata_json (nullable)
- created_at
- sync_status (PENDING|SYNCED|FAILED)
- synced_at (nullable)
- sync_error (nullable)
- retry_count

Rules:
- append-only table
- no update/delete by application logic

### stock_projection_by_variant
- product_variant_id (PK/FK -> product_variants.id)
- quantity_on_hand
- quantity_reserved (default 0)
- quantity_damaged (default 0)
- last_event_ts
- updated_at

### stock_projection_by_location
- product_variant_id (PK-part)
- location_type (PK-part)
- location_id (PK-part)
- quantity_on_hand
- updated_at

Purpose:
- supports future multi-warehouse flow without schema break.

### report_daily_summary
- report_date (PK)
- factory_id (PK-part)
- total_production
- total_unique_qr
- inventory_value_cost
- inventory_value_sales
- generated_at

### sync_outbox
- id (text PK)
- aggregate_type (QR_MASTER|PRODUCTION_EVENT|PROJECTION)
- aggregate_id
- operation (INSERT|UPDATE)
- dedupe_key (text unique)
- payload_json
- status (PENDING|IN_FLIGHT|FAILED|SYNCED)
- available_at
- attempts
- last_error
- created_at
- updated_at

## Constraints and Indexes
Mandatory uniqueness:
- qr_master.qr_id primary key
- sync_outbox.dedupe_key unique
- product_variants(article, color, size) unique

High-value indexes:
- production_events(event_date)
- production_events(factory_id, event_date)
- production_events(product_variant_id, event_date)
- production_events(event_type, event_date)
- sync_outbox(status, available_at)
- qr_master(current_status)

## Why this is better than a scan-only design
- Supports current scanner needs and future lifecycle stages with same QR identity.
- Avoids re-architecting when dispatch/sales/returns start.
- Keeps local reads fast with dedicated projections and summaries.

## Cloud (Supabase Postgres)
Mirror these tables with equivalent constraints.
Cloud remains secondary for desktop operations and primary for cross-device analytics and consolidation.
