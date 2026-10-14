# Deployment Guide

Written for whoever installs or upgrades 777 ERP on a factory computer.

This describes **only what exists today**. Anything not listed under "What works today" is not
available, however often it has been discussed. Where an earlier version of this guide promised a
mechanism that was never built, the promise has been removed rather than softened.

## What works today

- A Windows desktop application, built with electron-builder as an NSIS installer (x64).
- One SQLite database per computer, at `%LOCALAPPDATA%\777-erp`. It is **outside** the
  installation folder, so it survives install, upgrade and uninstall.
- Migrations are applied automatically at startup, from the migration files the installed build
  ships (`resources/erp-resources/migrations/sqlite`).
- A schema-version guard that refuses to open a database newer than the installed build supports.
- Backups on demand from inside the application, checksummed and recorded.
- Build provenance: every build records which commit it came from.

## What does NOT exist

Do not plan a release around any of these:

- **No code signing.** No certificate has been obtained. Windows Smart App Control has blocked
  both the installer and the build step on this machine. Installing requires whatever manual
  allowance the operator's Windows configuration demands.
- **No cloud database and no synchronisation.** Each computer's database is independent. Nothing
  is shared between computers, in either direction.
- **No download site and no automatic updates.** Installers are copied to each machine by hand.
- **No staging environment.** There is nowhere to rehearse a release except a disposable copy of
  a database on a developer machine.
- **No automated rollback.** Only `*.up.sql` migrations are shipped — deliberately, because the
  application cannot run a migration backwards. See "Rollback".

## Release workflow

1. **Commit everything.** `npm run package:win` runs `write-build-info.mjs --strict`, which
   **refuses to build** when the tree has uncommitted or untracked changes, or when the commit
   cannot be determined. This is not a formality: electron-builder copies `migrations/sqlite`
   from the working tree, so a dirty build can ship a migration that exists in no commit, and
   that migration would then be applied permanently to a production database.
2. **Build and test.** `npm run build`, then `npm test`. Compare failures against the recorded
   baseline; a release should add none.
3. **Rehearse the migrations** on a restored copy of the production database, in a separate
   folder — never the live file. This matters most for migrations that rebuild a table rather
   than add to one.
4. **Record what you are about to install:** the version and commit from
   `apps/desktop/dist/main/build-info.json`, and the highest migration it ships.
5. **Back up the production database and verify the backup** (next section).
6. Install on one computer. Check it opens, scans, and writes.
7. Only then install on the rest.

## Back up before every upgrade

Use the application's own Backup action. It runs `VACUUM INTO`, which produces a consistent copy
even while the application is open, then records the file's SHA-256 checksum and size in
`backup_history` with status `VERIFIED`. Backups are written to a `backups` folder beside the
database.

Verify before upgrading, not afterwards:

- The row exists in `backup_history` and its status is `VERIFIED`.
- The file is present, and its size matches what was recorded.
- Write down the backup path, its checksum, and the database's migration level.

A backup whose checksum has not been confirmed is not a backup you can plan a rollback around.

## Upgrading

Install the new build over the old one. The database is not in the installation folder, so the
installer does not touch it. On first launch the new build applies any migrations it has that the
database does not, inside a single transaction.

After upgrading, the database is at the new build's schema level. **This is the point of no
return** — see below.

## Rollback

**Rolling back the executable alone is unsafe once the database has advanced.** The database stays
where it is; only the program is replaced. An older build has fewer migration files, finds nothing
pending, and would otherwise read and write a schema it was never written for.

The schema-version guard now prevents that: an older build refuses to open a newer database and
says so, naming the database's schema level, the level it supports, and the database path. It
changes nothing when it refuses.

**The guard prevents the damage. It does not reverse a migration.** There is no down path: the
installer ships no `.down.sql`, and nothing in the application executes one.

So a true rollback means going back to **both** the older build **and** a database from that
build's era:

1. Install the older build.
2. Restore the backup taken **before** the upgrade, at the schema level that build supports.

Restoring a backup **overwrites the live database**. Everything recorded since that backup —
every scan, voucher, gatepass and ledger entry — is gone. That is a business decision about
losing a day's work, not a technical step to take quietly. Get it decided explicitly, in writing,
by whoever owns the data.

If the data recorded since the upgrade matters more than the problem being rolled back, the
answer is to fix forward on the newer build, not to roll back.

## After installing

Check, on the machine itself:

- The application opens to the sign-in screen; no startup dialog appeared.
- `startup.log` has no failure entry, and the log's `build-provenance` line shows the version and
  commit you intended to install — and does **not** say `DIRTY BUILD`.
- A QR code scans, and a duplicate scan is refused.
- Stock and a ledger both read correctly for a known product and party.
- The Backup action still works.

## If the application refuses to start

It reports one dialog and names a log file. Two failures are reported this way:

- **Filesystem locations** — the data folder could not be prepared.
- **Database** — including a database newer than the build supports, which is the guard above.

Send `startup.log` from the logs folder beside the database. It records environment and error
text only: no passwords, no tokens, no business data.
