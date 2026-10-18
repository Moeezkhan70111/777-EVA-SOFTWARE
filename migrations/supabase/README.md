# Cloud schema — apply order

Nothing here has been applied to the Supabase project. These files are reviewed SQL waiting for
a decision, not a record of what the project contains.

**`005` and `006` are unapplied and stay that way until explicitly authorized.** Neither has
been run against any project, disposable or otherwise. `006` additionally **cannot** be applied
before the client changes: it revokes the direct `insert` the current transport relies on (see
step 6 below).

Apply in this order, in the Supabase SQL editor, on an **empty** project:

`002` → `003` → `004` → `005` → `006`

**Once `005` has been applied, never run `003` again.** This is an ordering hazard, not a fault
in either file and not a reason to rerun or edit a migration that is already applied.

`003` defines `log_production_produced_insert()` with no `factory_id` in its insert
(`003_sync_event_log.up.sql`, the `insert into public.sync_event_log (...)` column list). `005`
replaces that function with one that writes `factory_id`, and adds the
`sync_event_log_factory_scope` check constraint requiring every `PRODUCTION_PRODUCED` row to
have one. Both files use `create or replace function`, so re-running `003` silently reinstates
the older body.

The damage shows up later, at the worst moment: the next production scan inserts into
`production_events`, the trigger writes a log row with a null `factory_id`, the check constraint
rejects it, and because the trigger raises, **the `production_events` insert fails too**. Scans
start being refused by the database, and nothing about the error points at `003`.

If `003` is ever re-run by accident, re-apply `005` — it is written to be safe to repeat
(`add column if not exists`, `drop constraint if exists`, `create or replace`, and a backfill
guarded by `factory_id is null`), and its function block is what puts the correct body back.

| Step | File | What it does |
|---|---|---|
| 1 | `../../supabase/schema.sql` | The baseline tables, indexes and `updated_at` triggers. Turns RLS on and defines **no policies**, so everything is denied until step 4. |
| 2 | `002_align_with_local_model.up.sql` | Makes the tables able to hold what the local SQLite tables contain: ids as text, the gate statuses, timestamps and `metadata_json` as text, and stops the cloud rewriting `qr_master.updated_at`. |
| 3 | `003_sync_event_log.up.sql` | The ordered log a second computer reads from, filled by triggers on `qr_master` and `production_events` and append-only. **Do not re-run this after `005`** — it would reinstate a `log_production_produced_insert()` that omits `factory_id` and make later production scans fail at the check constraint. See the warning above. |
| 4 | `004_rls_policies.up.sql` | Who may read and write what. Creates `device_accounts`, the two policy helper functions, and every policy. **Nothing works before this.** |
| 5 | `005_sync_event_log_factory_scope.up.sql` (**unapplied**) | Gives `sync_event_log` a `factory_id` of its own, written by the production trigger and required by a check constraint, and filters the read policy by it. Without this a device can read another factory's production events out of the log, which 004 denies on the table itself. |
| 6 | `006_device_claims.up.sql` (**unapplied**) | Binds each enrolled account to one device id and one workstation, adds a monotonic claim epoch and holder, and moves both supported writes behind `push_qr_master` / `push_production_produced`, which validate the claim in the same transaction as the write. Revokes the direct `insert` on `qr_master` and `production_events`. **Breaks the current transport until it is changed to call the RPCs.** |

Each file is a single transaction and each has a matching `.down.sql`. The down files are only
safe on a project that has never been written to — once real rows exist, reversing the type
changes would have to discard data to succeed, and they are written to fail instead.

**Reverse in the opposite order: `006` → `005` → `004` → `003` → `002`.** Reversing `005`
re-opens the cross-factory read, and reversing `006` re-opens unbound access, re-enables any
device revoked before the rollback and discards the claim audit. Both headers say so. `004_rls_policies.down.sql` revokes a
privilege on `sync_event_log`, which `003` created — running `003`'s down first drops the table
and then `004`'s down fails on a table that is no longer there.

**Paste these into the Supabase SQL editor, not through a script that splits on semicolons.**
Migration `003` defines two `$$`-quoted function bodies that contain semicolons of their own. The
SQLite migration runner in this repository splits statements naively on `;` and would shred them;
it is for `migrations/sqlite/` only and must never be pointed at this folder.

`001_initial_schema.up.sql` is the original placeholder and applies nothing.

## After the SQL, before anything syncs

1. **Seed the one factory.** `insert into factories (id, code, name, timezone, is_active, created_at, updated_at) values ('factory-777', '777', '777 Manufacturing', 'Asia/Karachi', true, …)`. The id must be exactly `factory-777` — that is what the local installations already use.
2. **Create one Supabase Auth user per computer** (Authentication → Users → Add user). These are device accounts, not people.
3. **Enrol each one**: add a `device_accounts` row giving its `auth_user_id`, `factory_id` and `workstation_id`. An account that is not enrolled can authenticate and still read and write nothing.
4. **Provision the master data** each computer will need — its `workstations` row, the `operators` it names, and the `product_variants` its cartons belong to. None of this synchronises: a computer that meets a carton naming a product it does not have refuses it visibly rather than inventing one.

## What the push code must send

Migration 002 drops the `now()` defaults on the columns the contracts carry, so these are `not
null` with no default and the insert has to supply every one of them:

* `qr_master`: `qr_id`, `product_variant_id`, `created_at`, `updated_at`, `current_status`,
  `current_location_type`. The contract carries only the first three — `updated_at` is written
  from `createdAt`, and the last two come from `QR_MASTER_OPENING_STATE` in
  `packages/data/src/database/syncEvents.ts`, exactly as the local applier writes them. The
  insert policy refuses any value other than `PRODUCED` / `FACTORY`.
* `production_events`: every field the `PRODUCTION_PRODUCED` payload carries, plus
  `event_type = 'PRODUCED'`, which the insert policy also requires. `sync_status`, `retry_count`
  and `source_app` have defaults, and `source_app` is carried anyway.

## What must never be done

* **Never turn RLS off** to make something work. If a query is denied, the policy is wrong or the
  device is not enrolled.
* **Never put the `service_role` key in the desktop application.** It bypasses RLS entirely. The
  anon key is designed to ship and is worth nothing on its own here, because `anon` has no policy.
* **Never grant `update` or `delete`** on `production_events`, `qr_master` or `sync_event_log` to
  a client. History is corrected with a new event, never by editing an old one.

## What is still not covered

Only two event types have contracts: `QR_MASTER` and `PRODUCTION_PRODUCED`. Dispatch, returns,
store movements, damage and adjustments still share the old catch-all name locally and are
refused by both the policies and the receiving code. Billing, gatepasses, cash, purchases,
parties, raw materials, machine programs and users are entirely local. Stock quantities are
counters that must be recomputed from events, never carried as values.

## Carton identities are not scoped per factory

Decided 2026-10-17. `qr_master` and `product_variants` have no tenant column, so a carton
identity belongs to no factory, and migration 005 leaves its log rows global rather than
inventing an owner for them. Every enrolled device can therefore see every carton QR id and
product-variant id in the project — which is already true of the `qr_master` table itself.
Production events ARE scoped, and a check constraint makes an unlabelled one impossible.

Changing this is a schema change (a tenant column on `qr_master` and `product_variants`, a
backfill, and policies on both tables), not a policy change. A test in
`packages/sync/src/cloudSchema.test.ts` pins the current behaviour so that changing it fails
loudly.
