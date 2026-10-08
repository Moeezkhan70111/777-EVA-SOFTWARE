# Operations, Resilience, and Recovery

## Configuration Service Contract
Centralized config keys:
- factory.id
- factory.name
- database.path
- supabase.url
- supabase.anon_key
- sync.interval_seconds
- sync.batch_size
- sync.max_attempts
- reports.daily_generation_time
- backup.daily_time
- backup.retention_days
- log.level
- ui.theme
- ui.language

Rules:
- No hardcoded environment values in business logic.
- Secrets are encrypted at rest when stored locally.

## Structured Logging Standard
Required fields:
- timestamp
- module
- severity
- operation
- correlation_id
- user_id
- device_id
- message
- error_code
- error_details

Severities:
- DEBUG
- INFO
- WARNING
- ERROR
- CRITICAL

## Backup Strategy
- Automatic daily backup of SQLite database.
- Manual backup action from admin screen.
- SHA-256 checksum and restore test verification.
- Cleanup policy by retention days and minimum recent backup count.
- Restore operation writes immutable audit log entry.

## Health Monitoring Dashboard Inputs
- sqlite health
- supabase connectivity
- scanner status
- pending sync count
- failed/dead-letter count
- last successful sync
- db size
- free disk space
- backup status
- app version and device identity

## Error Recovery Playbooks
- SQLite locked: retry with jitter and short timeout fallback.
- Internet down: continue local writes, queue sync.
- Supabase down: switch worker to degraded mode and raise warning.
- Scanner unplugged: visual warning + auto reconnect loop.
- Power loss/crash: WAL recovery + stale in-flight outbox reset on startup.

## Performance SLO Targets (V1)
- Scan commit latency p95 under 100 ms
- App startup under 2 seconds on target hardware
- UI main thread freeze budget under 50 ms spikes
- Sync backlog drain throughput configurable by environment

## Observability Metrics
- scans_total
- scans_success_total
- scans_invalid_total
- scans_duplicate_total
- scan_latency_ms_p50_p95
- sync_attempt_total
- sync_success_total
- sync_failure_total
- sync_queue_depth
- report_generation_duration_ms
