# Cloud schema — apply order

**Where each project stands (test 1 Nov 2026; production 31 Oct 2026):**

- **Test** (`wpkrhgqsizjjdaztijwv`): the baseline and `002`–`025` are applied. 020–023 on 1 Nov;
  `check_accounts.sql`, `check_permission_requests.sql`, `check_first_admin.sql`, `check_suggested_access.sql`
  and `check_number_blocks.sql` pass. `024` is applied (its email check is in `make_first_admin`).
  `025` applied 3 Nov: `check_role_codes.sql` stopped at its step 3 before it and passes after it;
  `check_accounts.sql` passes after it too. `026` applied to test 3 Nov, `027` on 6 Nov, `028` on 7 Nov; `check_carton_stock_events.sql` covers 026 and 027.
- **Production** (`ykhvbmhmeefdtrzqeoxm`): the baseline and `002`–`018` applied 31 Oct, `factory-777`
  seeded, `verify_applied_state.sql` 34/34. No devices enrolled and no business data yet. The
  `check_*.sql` scripts are never run here.

Apply in this order, in the Supabase SQL editor, on an **empty** project, one file at a time:

`schema.sql` → `002` → `003` → … → `019` → `020` → `021` → `022` → `023` → `024` → `025` → `026` → `027` → `028` → `029` → `030` → `031`

After each one, run `verify_applied_state.sql`. Its header lists exactly which checks a project
one migration behind fails, so a half-applied project is diagnosed rather than guessed at. The
`check_*.sql` files are functional checks for one migration each, **for the test project only**:
each one leaves nothing behind (it ends by raising, so everything rolls back) and reports
`..._CHECK_PASSED` on success.

`reset_accounts_on_test.sql` resets cloud accounts **on test** to a fresh 020–024 state, for a
rehearsal from a clean start: the account data and the account events in the log (which undoing
020–024 would leave behind, making every computer ignore the restarted revisions). It refuses on a
project without the rehearsal computers. Paste it into an empty tab and run it with nothing
highlighted: the SQL editor runs only highlighted text. Run on test 2026-11-02.

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
| 5 | `005_sync_event_log_factory_scope.up.sql` | Gives `sync_event_log` a `factory_id` of its own, written by the production trigger and required by a check constraint, and filters the read policy by it. Without this a device can read another factory's production events out of the log, which 004 denies on the table itself. |
| 6 | `006_device_claims.up.sql` | Binds each enrolled account to one device id and one workstation, adds a monotonic claim epoch and holder, and moves both supported writes behind `push_qr_master` / `push_production_produced`, which validate the claim in the same transaction as the write. Revokes the direct `insert` on `qr_master` and `production_events`. |
| 7 | `007_close_leftover_grants.up.sql` | Closes three grants found by verifying the applied schema rather than trusting it. |
| 8 | `008_push_product_variant.up.sql` | `push_product_variant`: a computer may send the products its cartons belong to. |
| 9 | `009_sync_event_log_any_type.up.sql` | The log stops being hard-wired to two event types: its types become rows in `sync_aggregate_types`, and the factory scope a trigger. |
| 10 | `010_close_maintain.up.sql` | Closes the PostgreSQL 17 `MAINTAIN` privilege, which 007 could not have known about. |
| 11 | `011_domain_leases.up.sql` | The write lease: one computer at a time writes each leased domain. Check: `check_leases.sql`. |
| 12 | `012_raw_material_identity.up.sql` | Raw-material label runs and packets reach the cloud from the store computer. Check: `check_raw_material_identity.sql`. |
| 13 | `013_leased_records.up.sql` | Master data travels as whole records, replaced by revision. Check: `check_leased_records.sql`. |
| 14 | `014_device_sync_health.up.sql` | Each computer reports, in one row, whether it is waiting on anything. Check: `check_sync_health.sql`. |
| 15 | `015_stock_events.up.sql` | Raw-material stock movements reach the other computers. Check: `check_stock_events.sql`. |
| 16 | `016_sync_log_doorbell.up.sql` | A doorbell on the log, so a reading computer pulls within seconds. Check: `check_doorbell.sql`. |
| 17 | `017_product_variant_log.up.sql` | Product variants reach the log, so a new computer can hold the cartons of them. |
| 18 | `018_number_block_registry.up.sql` | The number-block registry: the cloud refuses a second computer on a number block already taken (the PC2/PC3 incident, docs/39 §4.4). Check: `check_number_blocks.sql`. **A client from before 018 cannot sync once it is applied.** |
| 19 | `019_close_rls_auto_enable.up.sql` | Takes `EXECUTE` on Supabase's own `rls_auto_enable()` away from `anon` and `authenticated`. Its event trigger still switches RLS on for every new table. |
| 20 | `020_cloud_accounts.up.sql` | Cloud accounts (docs/41): people sign up on an enrolled PC, an admin approves them once, and the account works on every PC. Adds `people`, `account_roles`, `person_tokens`, `account_events` and the `PERSON` and `ACCOUNT_ROLE` log types. Check: `check_accounts.sql`. **Test only until after PC2's cutover**; production stays at `019`. Then `make_first_admin` is run once, by the owner, in the SQL editor. |
| 21 | `021_permission_requests.up.sql` | Permission requests go to the cloud (docs/41 §8): a request for one more screen is made and decided here, and an approval reaches every PC as the person's next `PERSON` revision. Adds `account_permission_requests`, the `PERMISSION_REQUEST` log type, and `account_state()`: the whole account state, read once by a PC switching to cloud accounts. Check: `check_permission_requests.sql`. **Test only until after PC2's cutover.** |
| 22 | `022_first_admin_designation.up.sql` | The first admin can be named before they exist, at the one enrolled computer they will claim from: `select make_first_admin('<email>', '<device id>')`. That claim arrives as an approved admin, once, while no admin exists; the same email anywhere else arrives PENDING. Lets the owner switch PC2 by hand with an admin already in place (docs/41 §12). Check: `check_first_admin.sql`. **Test only until after PC2's cutover.** |
| 23 | `023_suggested_access.up.sql` | An account that moves up brings the role, screens, job role and authority it had on its computer, as a suggestion the cloud keeps while it waits; the admin approving it on any computer starts from it. Never access: cleared the moment the person is decided. Check: `check_suggested_access.sql`. **Test only until after PC2's cutover.** |
| 24 | `024_login_bookkeeping.up.sql` | Two rehearsal findings (2 Nov): `verify_login` records a sign-in only once the person is let in (a revoked person's right password was recorded as their last sign-in), and `make_first_admin` refuses anything that is not an email address (the placeholder `<your email>` was run as it stood). Signatures unchanged. Check: `check_login_bookkeeping.sql`. **Test only until after PC2's cutover.** |
| 25 | `025_role_create_never_overwrites.up.sql` | A new role never overwrites an existing one. `admin_save_role` with no code (the Roles screen's "new role") codes it from its name; a role keeps its code when renamed, so creating a role under a name another role once had replaced that role's screens. Now a create whose code a live role holds is refused as `ROLE_CODE_TAKEN`; editing by code and bringing back a deleted role are unchanged. Signature unchanged. Check: `check_role_codes.sql`. **Test only until after PC2's cutover.** |
| 26 | `026_carton_stock_events.up.sql` | Carton stock movements reach every computer (docs/42): Manual Production, its void, a gatepass taking its cartons out when made, and its cancel. Adds `carton_stock_events`, the `CARTON_STOCK_EVENT` log type (unscoped, 003's ordering lock) and the `CARTON_STOCK` lease, under which `push_carton_stock_event` accepts them. Gatepass and Manual Production ids travel as references only. Check: `check_carton_stock_events.sql`. **Not on production until after PC2's cutover AND the cloud-accounts release; ships with local migration 101.** |

Each file is a single transaction and each has a matching `.down.sql`. The down files are only
safe on a project that has never been written to — once real rows exist, reversing the type
changes would have to discard data to succeed, and they are written to fail instead.

`027_carton_stock_adjustments.up.sql` follows `026`: an administrator's carton adjustment reaches every computer, with who and why (docs/42 section 11). Test only. Not on production.

`028_production_to_cash_records.up.sql` follows `027`: products, Manual Production entries, gatepasses, bills and cash vouchers become leased records under 013's push (docs/43). Rows only, no new function. Test only. Not on production.

`029_color_translation_records.up.sql` follows `028`: the English-to-Urdu colour list becomes a leased master-data record (docs/45, local migration 106). Rows only, no new function. **Prepared, not applied to test or production.** Until it is, a colour revision waits as `UNKNOWN_RECORD_TYPE` without holding up anything else.

`030_carton_stock_adjustment_records.up.sql` follows `029` (it does not need it): Opening Stock and Stock Adjustment documents become a leased record under the carton lease (docs/46, local migration 107). Rows only, no new function; their cartons move by `CARTON_ADJUST_IN` / `CARTON_ADJUST_OUT`, which `027` already accepts. **Prepared, not applied to test or production.** Until it is, a document waits as `UNKNOWN_RECORD_TYPE` while its movements travel.

`031_raw_material_master_on_store_lease.up.sql` follows `030`: units, unit ladder presets, categories and materials move from MASTER_DATA to RAW_MATERIAL_STORE in `leased_record_types` (docs/47), so the store computer writes its materials with their stock. Rows only. **Prepared, not applied to test or production.** Apply before the store computer runs the release that writes them under the store lease.

**Reverse in the opposite order: `031` → `030` → `029` → `028` → `027` → `026` → `025` → `024` → `023` → `022` → `021` → `020` → `019` → `018` → … → `003` → `002`.** Each down file's header
says what reversing it costs: `018`'s re-opens the PC2/PC3 failure, for example. Reversing `005`
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
