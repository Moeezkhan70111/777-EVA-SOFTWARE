# Testing Strategy (Enterprise)

## Test Pyramid
- Unit tests: domain rules, parser versions, validation, idempotency rules.
- Integration tests: SQLite transactions, projection updates, outbox worker, migration scripts.
- End-to-end tests: scan input to committed record to sync completion.

## Required Test Suites
1. QR validation and parsing
- valid V1 payloads
- malformed separators/fields
- unsupported version payloads

2. Duplicate protection
- duplicate scan in same session
- duplicate scan after app restart
- duplicate sync replay

3. Offline and reconnect
- internet unavailable for extended period
- backlog sync and idempotent convergence

4. Transaction safety
- forced failure at each transaction step and rollback verification

5. Projection correctness
- stock by variant and by location after mixed event streams

6. Migration reliability
- upgrade path from empty DB to latest
- rollback path for reversible migrations
- data preservation checks

7. Backup and restore
- backup creation checksum verification
- restore to clean environment
- post-restore consistency checks

8. Performance and load
- sustained burst scans
- 1M QR and 10M event query benchmarks
- latency and startup SLO checks

9. Failure recovery
- simulated SQLite lock contention
- scanner disconnect/reconnect
- crash during sync in-flight state

## Automation Targets
- CI pipeline runs unit + integration on every commit.
- Nightly pipeline runs heavy load/performance suites.
- Release gate fails if migration, sync, or recovery tests fail.
