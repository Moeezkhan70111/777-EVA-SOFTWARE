# 36 — Setup and recovery guide (multi-PC sync + automatic updates)

**Status: IN PROGRESS.** The recovery procedures in §1–§4 and the token specification in §5 are
complete and were written against the code as it stands (ceiling 84, Phase 2). The setup sections
§6–§8 are filled in at Phase 8, once sync is wired.

Written 2026-10-22.

---

## 1. Before you read the rollback procedure: what the code actually permits

Four facts decide everything below. Each was read from the code, and the one that matters most is
pinned by a test.

**1. There is no downgrade path in the application.** `electron-builder.yml` ships only
`*.up.sql` (the `filter:` under `extraResources`), and nothing in the application executes a
`.down.sql`. The `.down.sql` files exist for review only.

**2. An older build REFUSES to open a newer database.**
`SqliteDatabase.ensureDatabaseIsNotNewerThanThisBuild()` compares the database's recorded
migration ceiling against the highest `*.up.sql` the installed build ships, and throws before
touching anything. So installing 0.3.1 over a database that 0.3.2 migrated does not corrupt it —
it refuses to start, with a dialog naming both numbers. This is deliberate and is your friend:
the failure is loud and nothing is damaged.

**3. Automatic updates cannot go backwards.** `allowDowngrade` is not set, so it is false.
electron-updater will not install a version lower than the one running. **You cannot roll back by
publishing an older version** — the office PCs will ignore it.

**4. RESTORING A BACKUP DOES NOT UNDO AN UPGRADE.** `SqliteDatabase.restoreBackup()` copies the
file into place and then calls `bootConnection()`, which runs the migrations again. On the new
build, restoring a pre-upgrade backup walks it straight back up to the new schema. Pinned by
`packages/data/src/preMigrationBackup.test.ts` — "restoring a pre-upgrade backup on a NEWER build
migrates it forward again".

> **The in-app Restore button cannot perform a version rollback.** It is for recovering *data*,
> on the build you are already running. A version rollback has to replace the application first.
> That ordering is the whole content of §4.

---

## 2. First, decide which situation you are in

A bad version has reached the office PCs. Before anything else, establish **whether it ran a
migration**, because the two cases have different recoveries and only one of them loses data.

Open `%LOCALAPPDATA%\777-erp\logs\app.log` on any affected PC and find the most recent
`"operation":"database-backup"` line. It is written only when migrations actually ran.

| What you find | Situation | Go to |
|---|---|---|
| No `database-backup` line since the upgrade | **Case A** — code-only bad version, schema untouched | §3 |
| A `database-backup` line, with `fromVersion` < `toVersion` | **Case B** — the upgrade migrated the database | §4 |

The same line also gives you `backupPath` — the file §4 needs. Record it before you change
anything.

---

## 3. Case A — the bad version did NOT migrate the database

No data is at risk and nothing needs restoring. **Fix forward.** Do not uninstall anything.

**A1. Stop it spreading.** On GitHub → Releases, **delete the bad release** (or set it to draft).
electron-updater reads `latest.yml` from the release assets, so once the release is gone no
further PC will find it.

**A2. Cancel it on PCs that downloaded but have not restarted.** A downloaded update installs on
the next ordinary quit (`autoInstallOnAppQuit`), so **deleting the GitHub release does not
un-stage one that is already on a PC.** Step A1 stops further PCs fetching it; this step stops
the ones that already have it.

*Which PCs have staged it?* **There is no central view** — nothing reports anywhere until cloud
sync covers it. Per PC, `Settings → Cloud Sync`'s update state shows `READY` with the version
waiting, and the log records "downloaded and will install when 777 ERP is restarted". You have to
look at each machine.

*The one central brake* is **revoking `ERP_UPDATE_TOKEN`** (§5): no PC can download anything, and
every PC keeps working normally. Do that first if the bad version is still spreading.

*To clear a staged install*, an administrator uses **Discard downloaded update** on that PC. It
turns off install-on-quit and deletes the staged file, so the PC stays on the version it is
running. Failing that — on a PC nobody can sign in to, say — close 777 ERP and delete:

```
%LOCALAPPDATA%\@erpdesktop-updater\pending
```

That folder name comes from `updaterCacheDirName` in the installer's `app-update.yml`. Deleting it
discards the staged installer and nothing else — no business data lives there.

Note that discarding only clears what is on disk now. If the release still exists and the token
still works, the next check finds the same version again — which is why A1 or a token revocation
comes first.

**A3. Publish the fix as a HIGHER version.** Revert the bad code in git, then:

```
npm run release
```

If the bad version was 0.3.4, the fix ships as 0.3.5 carrying 0.3.4's predecessor's behaviour.
The PCs pick it up within four hours or on their next start.

**Never re-use or re-tag a published version number.** A PC that already has 0.3.4 will not
download a different 0.3.4, and `release.mjs` refuses an existing tag anyway.

**A4. For one urgent PC**, install the previous installer by hand from `apps/desktop/release` or
`release-archive`. The database opens normally because its ceiling never moved.

---

## 4. Case B — the bad version DID migrate the database

Read §4a before §4b. The right answer is almost always §4a, and §4b loses work.

### 4a. Preferred: fix forward with a new migration

**No data is lost, and this is the only option that keeps all PCs consistent.**

Migrations are append-only. If migration 085 did the wrong thing, the fix is migration 086 that
corrects it — not an attempt to un-run 085.

1. Write the corrective migration and its matching `.down.sql`.
2. Test it against a **copy** of a real affected database, never the live one.
3. `npm run release` — the fix ships as a higher version and every PC converges on it.
4. Delete the bad release on GitHub so no PC installs the bad build fresh (§A1).

Choose this unless the bad migration destroyed data that no later migration can reconstruct. A
migration that added a wrong column, wrote wrong values, or built a wrong index is all
fix-forward territory.

### 4b. Last resort: restore the pre-migration backup and go back a version

**This loses every transaction entered on the bad version** — every gatepass, bill, scan,
production event and voucher recorded between the upgrade and the restore. Decide that is
acceptable before starting, and say so to whoever was working on that PC.

**It also diverges the PCs.** Any work that had already synced to the cloud (carton identities and
production events) comes back on the next pull; everything that does not sync — billing,
gatepasses, stock movements, cash, parties, raw materials, machine programs — does not. After a
rollback on one PC, that PC's local-only records are gone while the others' are not.

Do this on **one PC at a time**, and do the steps in this order. The order is the procedure.

1. **Close 777 ERP** on that PC. Confirm no `777 ERP.exe` is running in Task Manager — two
   processes on one WAL database is how local data gets corrupted.

2. **Copy the pre-migration backup somewhere safe, outside the data folder.** Its path is the
   `backupPath` from the `database-backup` log line (§2). Something like:

   ```
   %LOCALAPPDATA%\777-erp\backups\erp-premigration-84-to-85-2026-10-22T….sqlite
   ```

   Copy it to e.g. `C:\777-ERP-Rollback\`. **Copy, never move.**

3. **Copy the CURRENT database aside too**, to the same place, under a name that says what it is
   (`erp-bad-version-2026-10-22.sqlite`). It holds the work that is about to be lost, and it is
   the only copy of it. Do not skip this even though you are discarding it — if the rollback is
   the wrong call, this file is the way back from the way back.

4. **Uninstall the bad version**, then **install the previous version** from its installer. The
   database lives in `%LOCALAPPDATA%\777-erp`, outside the installation, so neither step touches
   it. **Do not start the application yet** — if you do, the old build will refuse to open the
   newer database (§1 fact 2), which is harmless but will look alarming.

5. **Replace the database file, with the application closed.** In `%LOCALAPPDATA%\777-erp`:
   - delete or rename `erp.local.sqlite`, and any `erp.local.sqlite-wal` / `-shm` beside it;
   - copy your saved pre-migration backup in and rename it to exactly `erp.local.sqlite`.

   **Do this through the file system, not through the application's Restore button.** The Restore
   button would migrate the restored file straight back up to the new schema (§1 fact 4) and you
   would have lost the work for nothing.

6. **Start 777 ERP.** The old build now sees a database at its own ceiling and opens normally. It
   will not migrate anything, so no new pre-migration backup is written.

7. **Check the business figures against the paper books** before anyone works in it — the same
   check as `docs/35 §7 step 5`. A restored database opens looking like a working ERP whatever is
   in it, so confirm a recent gatepass, a party balance and one stock figure by hand.

8. **Stop that PC updating itself straight back onto the bad version.** The release should already
   be deleted (§A1). If it is not, delete it, or remove `ERP_UPDATE_TOKEN` from that PC until the
   fix is published — without the token it reports that updates are off and keeps working.

9. **When the fix ships**, that PC takes it like any other PC. Re-add the token if you removed it.

### 4c. What is NOT a recovery procedure

- **Publishing an older version.** `allowDowngrade` is false; the PCs ignore it (§1 fact 3).
- **Running a `.down.sql` by hand against a live database.** Nothing ships them, nothing has
  tested them against real rows, and the headers on several say they are written to fail rather
  than lose data. If you believe one is the answer, test it on a copy and treat it as a one-off
  repair script, not a supported path.
- **Deleting `schema_migrations` rows** to make an older build accept the database. The build
  would then run on a schema it was never written for, silently, against live inventory and
  accounting data. This is the worst available option.

---

## 5. The two tokens, and exactly what each may do

Two different credentials, on two different machines. Neither is ever committed, and neither is
baked into the installer — verified: the packaged `resources/app-update.yml` contains only
`owner`, `repo`, `provider`, `private` and `releaseType`.

### `GH_TOKEN` — developer PC only, for publishing

Set in the release terminal only, never in a file.

| Setting | Value |
|---|---|
| Type | Fine-grained personal access token |
| Resource owner | `Moeezkhan70111` |
| Repository access | **Only select repositories** → `777-EVA-SOFTWARE` |
| Repository permissions | **Contents: Read and write** |
| | **Metadata: Read-only** (GitHub adds this automatically) |
| Everything else | not granted |

Write access is required because publishing creates a release and uploads the installer.

### `ERP_UPDATE_TOKEN` — each office PC, for downloading

| Setting | Value |
|---|---|
| Type | Fine-grained personal access token |
| Resource owner | `Moeezkhan70111` |
| Repository access | **Only select repositories** → `777-EVA-SOFTWARE` |
| Repository permissions | **Contents: Read-only** |
| | **Metadata: Read-only** (added automatically) |
| Everything else | not granted |
| Account permissions | none |

**Read-only is sufficient**, and it is all that is wanted: nothing in the application writes to
GitHub. The only thing this token does is list releases and download a release asset from one
private repository. `Contents: Read-only` is the narrowest permission that allows that — a
private repository's release assets are served through the contents API.

**This cannot be verified from the code.** A token's scope lives in GitHub, not in the
repository, so check it at
**GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**, open
the token, and confirm the table above line for line. If it says "All repositories", or lists any
write permission, **create a new one and revoke that one** — it is on three or four factory PCs in
a readable environment variable.

### Operational notes

- **Treat it as semi-public.** It sits in an environment variable on shared factory machines.
  Read-only on one repository is what makes that acceptable.
- **Fine-grained tokens expire.** GitHub requires an expiry date, so this token *will* stop
  working. When it does, the PCs keep running normally and the log records
  `"operation":"auto-update"` with "This computer's update credential was refused". Put the expiry
  date in a calendar.
- **Revoking it is a safe emergency brake.** A PC with no valid token reports that updates are off
  and carries on working. Revoking stops every PC updating — which is exactly what you want while
  a bad version is being sorted out.
- **One token for all office PCs is acceptable**; one per PC is better only because it can be
  revoked individually. Either is fine at this scale.

---

## 5a. TEMPORARY ACCESS THAT MUST BE REMOVED BEFORE THE OFFICE PCs GO LIVE

Two grants exist only to let the cloud schema be applied from a developer machine. **Neither is
part of running the ERP, and both must be gone before an office PC is in daily use.** They are
written here rather than left in a chat log because the person who removes them will not be the
person who added them, and because nothing in the application will ever complain about their
still being there.

| What | Where | Why it exists | Remove by |
|---|---|---|---|
| `mcp__supabase__apply_migration` in the permission allow-list | `.claude/settings.local.json` | Lets the schema be applied without a prompt per file | Deleting the `permissions.allow` entry |
| Supabase MCP server **write access** | `.mcp.json`, OAuth session | Lets an agent create tables, policies and RPCs in the live project | Narrowing `features=` to `docs` only, or removing the server block, and revoking the OAuth grant in the Supabase dashboard |

**Why this matters more than it looks.** The MCP grant is OAuth against the account, so it carries
access to **every organization and project that account can reach**, not just this one. It is a
schema-setup tool. Once the schema is applied it buys nothing and risks a mistaken `drop` against
production inventory and accounting data.

**What the running ERP actually needs, and all it needs:**

* each office PC: `ERP_SUPABASE_URL` and `ERP_SUPABASE_ANON_KEY`, plus its device email and
  password on first sync only;
* nothing else. **No MCP server, no personal access token, no `service_role` key, and no
  allow-list entry on any office PC.**

**Checklist before the first office PC goes live:**

1. Remove the `permissions.allow` entry from `.claude/settings.local.json`.
2. Narrow or remove the `supabase` block in `.mcp.json`, and revoke the OAuth grant in the
   Supabase dashboard (Account → Apps / Authorized applications).
3. Confirm no office PC has `.mcp.json`, a Supabase access token, or a `service_role` key
   anywhere in its environment.
4. Re-read §5 and confirm `ERP_UPDATE_TOKEN` on each PC is **Contents: Read-only, one
   repository** — the only long-lived credential an office PC is meant to hold.

If the schema ever needs changing again, re-granting access for the duration of that change is
the correct move. Leaving it granted between changes is not.

---

## 6. Backups — where they are, and when to clear them

**Location:** `%LOCALAPPDATA%\777-erp\backups`

Three kinds live there, all visible in Settings:

| `backup_type` | When it is written |
|---|---|
| `PRE_MIGRATION` | automatically, immediately before any migration run |
| `MANUAL` | when somebody presses Backup in Settings |
| `AUTO_DAILY` | reserved; nothing writes one yet |

**Nothing is pruned automatically, deliberately.** A safety copy is the last file that should be
deleted on a timer, and an upgrade that went wrong is exactly when one is needed. The cost is that
the folder grows.

**How fast:** one file per upgrade, each about the size of the database — ~16 MB today. A handful
of releases a year is a few hundred megabytes. This is slow growth, not a problem to solve, but it
is growth.

**When to clear them by hand:**

- Keep **every `PRE_MIGRATION` backup from the last two upgrades**, always. Those are the ones a
  rollback could still need.
- Keep the **most recent `MANUAL` backup**, and any you took deliberately before something risky.
- Anything older than that may be deleted **once the version it preceded has been running without
  complaint for a few weeks**, which is the real condition — not a date.
- Delete the **files**; the rows in Settings are history and harm nothing. A listed backup whose
  file is gone is not an error.

**Never delete a backup while an upgrade is in progress or unresolved**, and never delete the one
named in the most recent `database-backup` log line.

---

## 6a. APPLIED SET — what is actually in the cloud project

Project `wpkrhgqsizjjdaztijwv` (`https://wpkrhgqsizjjdaztijwv.supabase.co`), region ap-northeast-2.
Verified by query, not assumed. **Last checked 2026-10-23.**

| File | Applied? | How |
|---|---|---|
| `supabase/schema.sql` | **YES** | agent, `apply_migration` → `erp_000_baseline_schema` |
| `002_align_with_local_model.up.sql` | **YES** | by hand, Supabase SQL editor |
| `003_sync_event_log.up.sql` | **YES** | by hand, Supabase SQL editor |
| `004_rls_policies.up.sql` | **YES** | by hand, Supabase SQL editor |
| `005_sync_event_log_factory_scope.up.sql` | **YES** | by hand, Supabase SQL editor |
| `006_device_claims.up.sql` | **YES** | by hand, Supabase SQL editor |
| `007_close_leftover_grants.up.sql` | **YES** | by hand, Supabase SQL editor |
| `008_push_product_variant.up.sql` | **YES** | agent, `apply_migration` → `erp_008_push_product_variant` |

Only the baseline has a `supabase_migrations` row, because 002–006 were pasted in the editor
rather than applied through the migration tool. **This table is therefore the only record of
what is applied — keep it current.**

**Why 002–007 were applied by hand.** Both Supabase MCP write tools — `apply_migration` and
`execute_sql` — refuse SQL containing destructive statements, returning `declined` from a
server-side confirmation that a Claude Code permission allow-rule cannot pre-approve (tried; it
made no difference). 002–007 cannot avoid such statements: 002 drops and re-adds 12 foreign keys
in one transaction because a column's type cannot change while a key joins on it, and
004/005/006/007 consist largely of `revoke`, which *is* the access model.

**008 went through the tool.** It is one `create or replace function` plus a `revoke` on that new
function by name, which the detector accepts. So a migration that only adds a function can be
applied by the agent; one that changes the access model still cannot.

### Verified state, 2026-10-23

22 tables · RLS enabled on **22 of 22** · 10 policies (every one `TO authenticated`; none for
`anon`) · 6 RPCs (`claim_device`, `claim_is_current`, `heartbeat_device`, `push_qr_master`,
`push_production_produced`, `push_product_variant`) · seeded with 1 factory, 1 workstation,
35 product variants, 0 operators, 0 enrolments.

`push_product_variant` checked after applying 008, by query rather than by the tool's own
success: `SECURITY DEFINER`, `search_path=""`, and `EXECUTE` granted to `postgres` and
`authenticated` only — not `anon`, not `PUBLIC`. The direct insert on `product_variants` is
still closed (`authenticated` holds `SELECT` and nothing else), so the RPC remains the only way
a client can add a product.

Checks that passed, in the order they matter:

1. **The 003-after-005 trap is clear** — `log_production_produced_insert` carries the 005 body
   (`origin_device_id, factory_id` present). This is the check to re-run after *any* future
   change to the cloud schema.
2. `sync_event_log_factory_scope` constraint present, requiring a `factory_id` on every
   `PRODUCTION_PRODUCED` log row and forbidding one on `QR_MASTER` (which is global by the
   2026-10-17 decision).
3. `anon` holds **no** read or write privilege on `qr_master`, `production_events`,
   `sync_event_log` or `device_accounts`.
4. `authenticated` holds **SELECT only** on those tables — 006's `revoke insert` took effect, so
   the claim-validating RPCs are the only write path.
5. `device_accounts` grants `authenticated` exactly 11 named columns, and **`claim_epoch` and
   `claim_holder` are not among them** — which is what makes device eviction work at all.
6. `sync_event_log` has both `(seq)` and `(factory_id, seq)` indexes, so the pull stays cheap as
   the log grows.

### Gaps found and closed by 007 — verified fixed 2026-10-22

Each was found by querying the applied schema rather than trusting the migration headers.

* **`TRUNCATE` was never revoked** from `anon`/`authenticated` on any table. 004 and 006 revoke
  by name, and Supabase's default grant includes TRUNCATE, REFERENCES and TRIGGER. TRUNCATE is
  **not** constrained by row level security, so it was a second write path that 006's header
  claims does not exist. **Now: 0 such grants on any of the 22 tables.**
* **Three trigger functions had a mutable `search_path`** — `set_updated_at`,
  `refuse_sync_log_change`, `refuse_claim_log_change`. All SECURITY INVOKER, so hygiene rather
  than a hole. **Now: all three pinned to `search_path=""`**, and the
  `function_search_path_mutable` advisory is gone.
* **`device_reads_own_enrolment` re-evaluated `auth.uid()` per row.** **Now:
  `auth_user_id = (SELECT auth.uid())`**, and the `auth_rls_initplan` advisory is gone.

**The client-role grant surface, as it now stands — this is the line to re-check after any
future cloud change:**

| Role | Privileges anywhere in `public` |
|---|---|
| `anon` | **none at all** |
| `authenticated` | `SELECT` on 7 tables only: `factories`, `operators`, `product_variants`, `production_events`, `qr_master`, `sync_event_log`, `workstations` |

`device_accounts` is deliberately absent from that list: 006 revoked table-level `SELECT` and
granted 11 named columns instead. **`claim_epoch` and `claim_holder` are not among them**, which
is the only reason device eviction works — a device that could read the current claim could never
be superseded. Re-check that specifically after any change to that table.

### Advisories that remain, and why each is correct

No WARN-level advisory remains that is not intended:

* **8 × "signed-in users can execute SECURITY DEFINER function"** — these are `claim_device`,
  `heartbeat_device`, `push_qr_master`, `push_production_produced`, `current_factory_id`,
  `current_workstation_id`, `is_enrolled_device`. A device **must** be able to call them; that is
  the architecture 006 exists to create. Not findings.
* **1 × "anon can execute SECURITY DEFINER function"** — `public.rls_auto_enable()`, which is
  **Supabase's own**: owned by `postgres`, `search_path` already pinned, and it returns
  `event_trigger`, so it cannot be invoked as an RPC whatever `EXECUTE` says. Not ours to revoke.
* **14 × "RLS enabled, no policy"** (INFO) — those tables deny everything on purpose. Nothing
  synchronises them, so no policy is the correct policy.
* **9 × unindexed foreign key** (INFO) — these cover parent-side deletes, which this schema never
  performs: history is corrected with a new event, never by editing an old one.
* **14 × unused index** (INFO) — meaningless on a database with no traffic yet. Re-read this one
  after the pilot has run, not before.

Deliberately **not** changed: the 8 "signed-in users can execute SECURITY DEFINER function"
advisories (those are the claim and push RPCs — a device must be able to call them), the 14 "RLS
enabled, no policy" advisories (those tables deny everything on purpose), and
`public.rls_auto_enable()` (Supabase's own event-trigger function; it returns `event_trigger` so
it cannot be invoked as an RPC whatever `EXECUTE` says).

---

## 7. What has to happen before any two-PC test — the owner's checklist

**Nothing in this section has been done.** Verified on the developer PC on 2026-10-22: no `.env`
file, no `ERP_SUPABASE_*` variables in the environment, no `device-credential.bin` in the data
folder, and **zero `cloud-sync` entries in 8,989 lines of `app.log`**. The credential file is
written on the first successful sync, so its absence is proof that no sync has ever completed
here.

I cannot see inside a Supabase account, so I cannot tell you whether a project exists — only that
nothing on this machine has ever contacted one. Every step below is yours to run.

### 7.1 Cloud, once for the project

1. **Create the Supabase project.** Note its URL (`https://<ref>.supabase.co`) and its
   **publishable (anon)** key. **Never the `service_role` key** — it bypasses every policy, and
   the app refuses a key whose payload names that role.
2. **Apply the SQL in order, pasted whole into the Supabase SQL editor:**
   `supabase/schema.sql` → `002` → `003` → `004` → `005` → `006` from `migrations/supabase/`.
   **Do not run these through a script that splits on semicolons** — `003` defines `$$`-quoted
   function bodies containing semicolons, and a splitter shreds them.
3. **Never re-run `003` after `005`.** It silently reinstates a trigger body that omits
   `factory_id`, and the next production scan then fails a check constraint — scans refused by
   the database, with nothing in the error pointing at `003`. Detector:
   ```sql
   select position('origin_device_id, factory_id' in prosrc) > 0 as is_005_body
   from pg_proc where proname = 'log_production_produced_insert';
   ```
   `true` is correct. If it is ever `false`, re-apply `005` before the next scan.
4. **Seed the factory.** The id must be exactly `factory-777` — that is what every installation
   already uses:
   ```sql
   insert into factories (id, code, name, timezone, is_active, created_at, updated_at)
   values ('factory-777', '777', '777 Manufacturing', 'Asia/Karachi', true, now(), now())
   on conflict (id) do nothing;
   ```

### 7.2 Cloud, once per computer

5. **Create one Auth user per PC** (Authentication → Users → Add user). **One account per
   computer, not per person.** Record each email; the password is needed once, on that machine's
   first sync, and never again.
6. **Create the `workstations` row first**, including its `device_id` — migration 006 adds a
   composite foreign key, so enrolment fails without it.
7. **Enrol the device account:**
   ```sql
   insert into device_accounts (auth_user_id, factory_id, workstation_id, device_id, label, is_active, enrolled_at)
   values ('<auth user uuid>', 'factory-777', '<workstation id>', '<device id>', '<where it stands>', true, now());
   ```
   `device_id` and `workstation_id` must match that computer's own `device-identity.json`
   **exactly**. Either column left null is refused as `BINDING_INCOMPLETE`, deliberately.
8. **Provision the master data each PC will need** — its `operators`, and the `product_variants`
   whose cartons it will push. None of this synchronises; a computer meeting a carton for a
   product it does not have refuses it visibly rather than inventing one.

### 7.3 On each office PC

9. **Set the four cloud variables** in the environment the app starts in:
   `ERP_SUPABASE_URL`, `ERP_SUPABASE_ANON_KEY`, `ERP_DEVICE_EMAIL`, `ERP_DEVICE_PASSWORD`.
   After the first successful sync the refresh token is stored encrypted in
   `device-credential.bin` and the email and password are no longer needed — the URL and key
   still are.
10. **Set `ERP_UPDATE_TOKEN`** (§5), or that PC will never receive a new version.
11. **Assign the document-number range** in Settings → Document Number Range. The PC holding the
    existing documents presses **adopt** (range 1); every other PC is given 2–5 by an
    administrator, from your written record. **Until this is done that PC cannot create a
    numbered document or print a QR label** — scanning, production, dispatch and store work are
    unaffected, and it now says so at sign-in rather than at the printer.
12. **Install from a fresh installer. Never copy the data folder** between PCs — it carries
    `device-identity.json`, and both machines would then claim to be the same workstation.

### 7.4 On the developer PC

13. **Set `GH_TOKEN`** (§5) in the release terminal only.
14. **Ship the first build that contains the updater:** `npm run release` from a clean tree.
15. **Install that build by hand on every office PC.** The 0.3.1 currently installed contains no
    updater and will never update itself. This is a one-time round of the building; every
    release after it arrives on its own.

### 7.5 Then, and only then

A two-PC test is possible. Watch the **Other Computers** indicator in the navigation rail on both
machines rather than the logs: scan a carton on one and it should reach the other within about
five minutes, or immediately on **Send Now**.

---

## 8. A known limit: what "online" does and does not mean

`net.isOnline()` is Chromium's view of whether a **network route** exists. Electron's own
documentation says a `false` is a strong signal and a **`true` is inconclusive** — some link is
up, which says nothing about whether a particular remote host is reachable.

**So the reconnect trigger does not fire for the outage this office is most likely to have.**
When the LAN is fine and the internet is down, the interface never goes down, there is no
offline-to-online transition, and the scheduler never sees a reconnection. It catches the
cable-unplugged and wifi-off cases, which are real but rarer.

**What covers the gap instead:** the retry backoff is capped at **60 seconds**, so after the
internet returns the next ordinary retry picks it up within a minute. That is the real bound on
recovery time for a WAN outage — not the reconnect trigger, and not the five-minute interval.

This is pinned by a test — "LAN up / WAN down: no reconnect fires, and recovery rides the backoff
instead" in `packages/sync/src/scheduler.test.ts` — so the behaviour is visible in the suite
rather than discovered on the floor.

A reachability probe against the Supabase host would close the gap properly and is deliberately
not built: it is a second network path to maintain for an outcome the low cap already delivers.
Revisit it if a minute proves too long in practice, or if you want the indicator to distinguish
"no internet" from "Supabase is down".

---

## 9. Shipping an update

`npm run release` from a clean tree on the developer PC — it refuses a dirty tree, a missing
`GH_TOKEN` and an existing tag, and rehearses safely with `npm run release -- --dry-run`. See
`scripts/release.mjs`. Until a code-signing certificate exists (`docs/25`), Windows warns before
each update installs.
