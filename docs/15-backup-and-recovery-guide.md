# Backup and Recovery Guide

## Backup Policy
- Automatic daily backup at configured local time.
- Manual backup on demand.
- Keep encrypted copies where required by policy.

## Integrity Verification
- Generate SHA-256 checksum for each backup.
- Perform periodic restore verification to a temp database.
- Record status in backup_history.

## Retention
- Keep at least N recent daily backups.
- Delete backups older than retention window, except compliance-locked snapshots.

## Restore Procedure
1. Stop application safely.
2. Copy selected backup to restore location.
3. Validate checksum.
4. Open DB and run integrity checks.
5. Run pending migrations if required.
6. Start app in recovery mode and verify health snapshot.

## Recovery Scenarios
- Corrupt active DB
- Accidental settings damage
- Machine replacement
- Disaster recovery to new workstation
