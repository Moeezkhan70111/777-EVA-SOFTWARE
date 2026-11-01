# 36 — Setup and recovery guide (multi-PC sync + automatic updates)

**Status: IN PROGRESS.** The recovery procedures in §1–§4 and the token specification in §5 are
complete and were written against the code as it stands (ceiling 84, Phase 2). The setup sections
§6–§8 are filled in at Phase 8, once sync is wired.

Written 2026-10-22. Cloud sections updated 2026-10-23 for the move to a production project.

**Two cloud projects exist. Office PCs use production. Nothing in daily use may point at test.**

| | Production | Test |
|---|---|---|
| Project ref | `ykhvbmhmeefdtrzqeoxm` | `wpkrhgqsizjjdaztijwv` |
| URL | `https://ykhvbmhmeefdtrzqeoxm.supabase.co` | `https://wpkrhgqsizjjdaztijwv.supabase.co` |
| Region | ap-south-1 (Mumbai) | ap-northeast-2 (Seoul) |
| Role | the live ERP's cloud, created 2026-10-23 | the former pilot project, demoted to test 2026-10-23 |
| MCP server (`.mcp.json`) | `supabase-prod` | `supabase-test` |
| Applied state | §6a.1 | §6a.2 |

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
| Supabase MCP servers **`supabase-prod` and `supabase-test`**, each with `features=docs,database` (`execute_sql` and `apply_migration`, so **write** access) | `.mcp.json`, OAuth session | Lets an agent create tables, policies and RPCs in each project | Narrowing `features=` to `docs` only, or removing the server blocks, and revoking the OAuth grant in the Supabase dashboard. **`supabase-prod` first**: it is the one holding real data. |

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
2. Narrow or remove the `supabase-prod` and `supabase-test` blocks in `.mcp.json`, and revoke the
   OAuth grant in the Supabase dashboard (Account → Apps / Authorized applications).
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

## 6a. APPLIED SET — what is actually in each cloud project

These tables are the only record of what each project holds. Only migrations applied through the
MCP tool get a `supabase_migrations` row, and anything pasted into the SQL editor gets none. Keep
them current, and fill a row in only once it has been checked by query.

### 6a.1 Production — `ykhvbmhmeefdtrzqeoxm`

`https://ykhvbmhmeefdtrzqeoxm.supabase.co`, region ap-south-1 (Mumbai). Created 2026-10-23.

**Status: SET UP, 2026-10-31.** The baseline and 002–018 applied in order by the owner in the SQL editor,
each checked by query before the next; `factory-777` seeded; `verify_applied_state.sql` 34/34, then 019 (35/35). **PC2 enrolled 2026-10-31** (§7.6):
Auth user `store@gmail.com` (`c06feecb-…`), workstation `0727f22b-7c01-4ff6-94db-1471ac5dfbab`,
device `47c0dace-fe68-42cb-989c-e94f69c62c0f`, label "PC2 - store (DESKTOP-R1V8)", not yet claimed.
**No leases granted, no business rows.** Next: §10 cutover. The `check_*.sql` scripts are for test only and were not
run here.

Two slips on the way, both caught by the per-step check: the baseline, and later 007 and 008, were
first pasted into **test**. Re-running 007 and 008 there changed nothing; re-running the baseline
put back test's `trg_qr_master_updated_at` and unpinned `set_updated_at`, both repaired the same
day (002's and 007's own lines). Verification check 34 now catches the first.

| Step | File / action | How | Applied? | Verified? |
|---|---|---|---|---|
| 1 | `supabase/schema.sql` | **by hand**, SQL editor. The MCP tool's confirmation came back declined twice (its `drop trigger` lines), so the agent's step was pasted instead; there is no `supabase_migrations` row | **YES**, 2026-10-31 | **YES**, by query |
| 2 | `002_align_with_local_model.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 3 | `003_sync_event_log.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 4 | `004_rls_policies.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 5 | `005_sync_event_log_factory_scope.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 6 | `006_device_claims.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 7 | `007_close_leftover_grants.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 8 | `008_push_product_variant.up.sql` | **by hand**, SQL editor (pasted with 007; no `supabase_migrations` row) | **YES**, 2026-10-31 | **YES**, by query |
| 9 | `009_sync_event_log_any_type.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 10 | `010_close_maintain.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 11 | `011_domain_leases.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 12 | `012_raw_material_identity.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 13 | `013_leased_records.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 14 | `014_device_sync_health.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 15 | `015_stock_events.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 16 | `016_sync_log_doorbell.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 17 | `017_product_variant_log.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 18 | `018_number_block_registry.up.sql` | **by hand**, SQL editor | **YES**, 2026-10-31 | **YES**, by query |
| 18a | `019_close_rls_auto_enable.up.sql` | **by hand**, SQL editor | — | — |
| 19 | Seed: `factory-777` | agent, `execute_sql` | **YES**, 2026-10-31 | **YES**: same row as test |
| 20 | ~~Master data mirror from test~~ | **not done: superseded by §10.8.** The real database exists (PC2), so production's master data comes from its backfill, never from test | n/a | n/a |
| 21 | `verify_applied_state.sql`: all 35 checks `ok` | agent, `execute_sql` | **34/34** at 018, 2026-10-31 | 35 fails until 019 |
| 22 | Advisors: the same set as §6a.2, nothing new | **by hand**, dashboard → Advisors (the MCP servers do not enable the `debugging` feature) | — | — |

**Why some steps are by hand, and which ones.** The split is the same as on test, for the same
reason (§6a.2): the MCP write tools refuse SQL containing destructive statements. Seventeen files are
pasted by hand: **002–007 and 009–019**. 002 drops and re-adds foreign keys, and 003–007 and
009–018 contain the `drop`s and `revoke`s that *are* the access model. The baseline, 008, the seed,
the mirror and the verification all went through the tool on test, or are plain inserts and selects.

**011 before 012, 013 and 015**: their push RPCs call 011's `lease_holds`. 014 needs only 006. On a
project still at 010 the verification reports exactly checks 3, 7, 11, 15, 20, 22, 23, 24, 26, 27,
28, 29, 30, 31 and 32 as failing.

**One deliberate difference from test:** 007 and 008 are applied as part of the initial setup
rather than as fixes afterwards. `verify_applied_state.sql` checks for exactly the state test
reached after 007, so production has to match it on day one.

### 6a.2 Test — `wpkrhgqsizjjdaztijwv`

`https://wpkrhgqsizjjdaztijwv.supabase.co`, region ap-northeast-2. **Demoted to test 2026-10-23.**
It holds whatever the pilot wrote. Do not point an office PC at it. Verified by query, not
assumed. **Last checked 2026-10-23.**

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
| `009_sync_event_log_any_type.up.sql` | **YES**, 2026-10-25 | by hand, Supabase SQL editor (owner) |
| `010_close_maintain.up.sql` | **YES**, 2026-10-25 | by hand, Supabase SQL editor (owner) |
| `011_domain_leases.up.sql` | **YES**, 2026-10-25 | by hand, Supabase SQL editor (owner) |
| `012_raw_material_identity.up.sql` | **YES**, 2026-10-25 | by hand, Supabase SQL editor (owner) |
| `013_leased_records.up.sql` | **YES**, 2026-10-25 | by hand, Supabase SQL editor (owner) |
| `014_device_sync_health.up.sql` | **YES**, 2026-10-26 (verify 30/30, check_sync_health passed) | by hand, Supabase SQL editor (owner) |
| `015_stock_events.up.sql` | **YES**, 2026-10-26 (verify 31/31, check_stock_events passed) | by hand, Supabase SQL editor (owner) |
| `016_sync_log_doorbell.up.sql` | **YES**, 2026-10-27 (verify 32/32, check_doorbell passed) | by hand, Supabase SQL editor (owner) |
| `017_product_variant_log.up.sql` | **YES**, 2026-10-30 | by hand, Supabase SQL editor (owner) |
| `018_number_block_registry.up.sql` | **YES**, 2026-10-30 (verify 33/33, check_number_blocks passed) | by hand, Supabase SQL editor (owner) |
| `supabase/schema.sql`, **re-run by mistake** | 2026-10-31: put back `trg_qr_master_updated_at` and unpinned `set_updated_at`. **Repaired the same day** with 002's and 007's own lines; verify 34/34 | by hand (owner) |

**Verified 2026-10-25, after 013:** `verify_applied_state.sql`, all 29 checks `ok`. And
`check_leased_records.sql` passed all 6 steps, leaving test as it was (no records, lease events,
temporary devices or log rows; PC2's claim untouched at epoch 33):
* refused under another domain's lease;
* a first revision lands, logged as `TYPE:id:revision` with the reader's envelope;
* the same revision with the same content is DUPLICATE, and with other content REVISION_CONFLICT;
* a newer revision is UPDATED, and an older one SUPERSEDED with the record unmoved;
* a deletion is logged with no body;
* an unknown type, a malformed record, an oversized record and a stale epoch are each refused, on
  their own row, beside a row that lands;
* after a takeover, the old holder's next revision is refused.

**Verified 2026-10-25, after 011 and 012:** `verify_applied_state.sql`, all 27 checks `ok`. And
exercised, not only inspected, by two functional checks that act as a temporary second device and
roll themselves back (afterwards: no temporary rows, no lease events, no raw-material log rows,
PC2's claim untouched at epoch 33):

* `check_leases.sql`, 8 steps: grant, the holder accepted and a stale epoch, another device and
  another domain refused, a regrant to the holder changes nothing, takeover, A → B → A refuses A's
  first-tenure epoch, the history is append-only, no lease for an unknown device, and a client can
  neither grant nor read leases unenrolled.
* `check_raw_material_identity.sql`, 6 steps: refused without the lease, a run lands and is logged
  with exactly the reader's payload, a repeat is DUPLICATE, and in one call IDENTITY_CONFLICT,
  RUN_DOES_NOT_ADD_UP, PAYLOAD_INCOMPLETE and NOT_LEASE_HOLDER are refused beside a row that
  lands. Packets: RUN_NOT_REGISTERED_YET, PACKET_OUTSIDE_ITS_RUN, a half packing pair, SERIAL_CLASH,
  packing 2.5 round-trips, logged unscoped once each, and a superseded claim writes nothing.

Both are **test only**: they write and roll back, and on production even a rolled-back write would
leave gaps in the log's positions.

**Verified 2026-10-25, after 009 and 010:** `verify_applied_state.sql`, all 21 checks `ok`.
Checks 5 and 7 now pass: `anon` holds nothing, and `authenticated` exactly `SELECT` on the seven
synchronised tables, with no `MAINTAIN`. One check (20) first failed **in the script, not the
project**: it compared the type list in byte order, and the project's collation sorts
`PRODUCT_VARIANT` before `PRODUCTION_PRODUCED`. The script now sorts with `collate "C"`.

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

#### Verified state, 2026-10-23

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
   change to the cloud schema. Checks 1–6 here, and the grant surface below, are now one
   re-runnable query: `migrations/supabase/verify_applied_state.sql`.
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

#### Gaps found and closed by 007 — verified fixed 2026-10-22

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
| `anon` | **none at all** — *once 010 is applied; see the correction below* |
| `authenticated` | `SELECT` on 7 tables only: `factories`, `operators`, `product_variants`, `production_events`, `qr_master`, `sync_event_log`, `workstations` — *likewise* |

> **Correction, 2026-10-25.** This table was **not true when written**. The project runs
> PostgreSQL 17, which added the `MAINTAIN` privilege (VACUUM, ANALYZE, REINDEX, CLUSTER, LOCK
> TABLE), and the project's default privileges grant it on every new table. The first run of
> `verify_applied_state.sql`, which reads `pg_class.relacl` directly, found `anon` holding
> `MAINTAIN` on 13 tables and `authenticated` on 21. The earlier check read a view that does not
> show it. It is low-risk, because no client path can issue those commands, but it contradicts the
> access model. `010_close_maintain` revokes it, and changes the defaults so new tables stop
> inheriting TRUNCATE, REFERENCES, TRIGGER or MAINTAIN. Checks 5 and 7 prove it.

`device_accounts` is deliberately absent from that list: 006 revoked table-level `SELECT` and
granted 11 named columns instead. **`claim_epoch` and `claim_holder` are not among them**, which
is the only reason device eviction works — a device that could read the current claim could never
be superseded. Re-check that specifically after any change to that table.

#### Advisories that remain, and why each is correct

**The expected set for a project at 018** (production, read from its dashboard and accounted for by
query on 2026-10-31; test holds the same schema). The list written on 2026-10-23 counted a project at
008. Every difference since is a table or function that 009–018 added on purpose, named below.

* **16 × "signed-in users can execute SECURITY DEFINER function"** (WARN). Fifteen are the device
  API, and a device **must** be able to call them: the claim (`claim_device`, `heartbeat_device`),
  the policy helpers (`is_enrolled_device`, `current_factory_id`, `current_workstation_id`), the
  pushes (`push_qr_master`, `push_production_produced`, `push_product_variant`,
  `push_raw_material_qr_batch`, `push_raw_material_qr`, `push_leased_record`, `push_stock_event`),
  the leases (`current_leases`, `release_domain_lease`) and `report_sync_health`. Each checks the
  claim, or answers only about the caller. The sixteenth is `rls_auto_enable` (next item).
* **1 × "anon can execute SECURITY DEFINER function"** (WARN): `public.rls_auto_enable()`. **A
  finding, small.** See "rls_auto_enable" below.
* **25 × "RLS enabled, no policy"** (INFO). They deny every client on purpose. The 14 of the
  baseline and 006 (`app_settings`, `audit_log`, `backup_history`, `device_claim_events`,
  `devices`, `metrics_counters`, `metrics_timeseries`, `report_daily_summary`,
  `role_permissions`, `roles`, `stock_projection_by_location`, `stock_projection_by_variant`,
  `sync_outbox`, `system_health_snapshots`), plus 11 since: `sync_aggregate_types` (009),
  `lease_domains`, `domain_leases`, `domain_lease_events` (011), `raw_material_qr_batches`,
  `raw_material_qrs` (012), `leased_record_types`, `leased_records` (013),
  `inventory_stock_events` (015), `number_blocks`, `number_block_events` (018). Only the
  owner-run push functions and triggers touch them; computers read what they need from the log.
* **14 × unindexed foreign key** (INFO). The 9 of 2026-10-23 plus 5 since:
  `sync_event_log.aggregate_type` (009), `domain_lease_events.domain` (011),
  `leased_record_types.lease_domain` (013), `device_sync_health.factory_id` (014),
  `sync_log_doorbell.factory_id` (016). Every one points at a small reference table
  (factories, workstations, operators, product variants, the lease domains, the log's types) whose
  rows are never deleted, so the index the lint asks for would only ever serve a parent delete that
  does not happen.
* **15 or 16 × unused index** (INFO). Meaningless before any traffic: production has no rows.
  The 14 of 2026-10-23 plus `raw_material_qrs.idx_raw_material_qrs_batch_id` (012) and
  `inventory_stock_events.idx_inventory_stock_events_item_id` (015) make 16, all with zero scans
  by query on 2026-10-31; the dashboard said 15. One index is counted differently, and which one
  does not matter until there is traffic. Re-read this after the pilot has run, not before.

#### rls_auto_enable — what it is, and why anon should not hold EXECUTE

**What it is.** Supabase's own, not ours: present on both projects before any migration here,
owned by `postgres`, `SECURITY DEFINER`, `search_path` pinned to `pg_catalog`, and fired by
the event trigger `ensure_rls` on every `CREATE TABLE` in `public`, where it switches row level
security on for the new table. That is why every table here has RLS from the moment it exists.

**Why anon can execute it.** Its access list is empty, which in PostgreSQL means the default:
`EXECUTE` for `PUBLIC`, which every role inherits.

**What was wrong in this guide.** It said the function "cannot be invoked as an RPC whatever
EXECUTE says", because it returns `event_trigger`. **Tested on test, 2026-10-31: false.** As
`anon`, `select public.rls_auto_enable()` runs, as `postgres`, and returns.

**Why it is harmless anyway.** Its only action is `alter table ... enable row level security`
on the tables created by the DDL command currently firing. Called directly there is no such
command, so it does nothing. It can never switch RLS off, read a row or write one.

**Why it should still be closed.** Nothing but the event trigger needs to call it, and "a client
holds nothing it does not need" is the rule 007 and 010 enforce. **Revoking it does not stop the
event trigger:** proved on test, rolled back -- with `EXECUTE` revoked from `public`, `anon` and
`authenticated`, a role holding no `EXECUTE` created a table and RLS was still switched on. An
event trigger does not check the creator's `EXECUTE`. Migration 019 makes the revoke; once it is
applied, this item and the sixteenth "signed-in" item leave the expected set (15 and 0).
---

## 7. What has to happen before any two-PC test — the owner's checklist

**Nothing in this section has been done.** Verified on the developer PC on 2026-10-22: no `.env`
file, no `ERP_SUPABASE_*` variables in the environment, no `device-credential.bin` in the data
folder, and **zero `cloud-sync` entries in 8,989 lines of `app.log`**. The credential file is
written on the first successful sync, so its absence is proof that no sync has ever completed
here.

I cannot see inside a Supabase account, so I cannot tell you whether a project exists — only that
nothing on this machine has ever contacted one. Every step below is yours to run.

### 7.1 Cloud, once for the project — production

The project is `ykhvbmhmeefdtrzqeoxm` (created 2026-10-23). Record progress in §6a.1 as you go.

1. **Note its URL and its publishable (anon) key** (Project Settings → API). **Never the
   `service_role` key** — it bypasses every policy, and the app refuses a key whose payload names
   that role.
2. **Apply the SQL in this exact order.** Each file is one transaction. Check each one before
   starting the next.

   | # | File | Who |
   |---|---|---|
   | 1 | `supabase/schema.sql` | agent (`supabase-prod`, `apply_migration`) |
   | 2 | `migrations/supabase/002_align_with_local_model.up.sql` | **you, SQL editor** |
   | 3 | `migrations/supabase/003_sync_event_log.up.sql` | **you, SQL editor** |
   | 4 | `migrations/supabase/004_rls_policies.up.sql` | **you, SQL editor** |
   | 5 | `migrations/supabase/005_sync_event_log_factory_scope.up.sql` | **you, SQL editor** |
   | 6 | `migrations/supabase/006_device_claims.up.sql` | **you, SQL editor** |
   | 7 | `migrations/supabase/007_close_leftover_grants.up.sql` | **you, SQL editor** |
   | 8 | `migrations/supabase/008_push_product_variant.up.sql` | agent (`apply_migration`) |
   | 9 | `migrations/supabase/009_sync_event_log_any_type.up.sql` | **you, SQL editor** |
   | 10 | `migrations/supabase/010_close_maintain.up.sql` | **you, SQL editor** |
   | 11 | `migrations/supabase/011_domain_leases.up.sql` | **you, SQL editor** |
   | 12 | `migrations/supabase/012_raw_material_identity.up.sql` | **you, SQL editor** |
   | 13 | `migrations/supabase/013_leased_records.up.sql` | **you, SQL editor** |
   | 14 | `migrations/supabase/014_device_sync_health.up.sql` | **you, SQL editor** |
   | 15 | `migrations/supabase/015_stock_events.up.sql` | **you, SQL editor** |
   | 16 | `migrations/supabase/016_sync_log_doorbell.up.sql` | **you, SQL editor** |
   | 17 | `migrations/supabase/017_product_variant_log.up.sql` | **you, SQL editor** |
   | 18 | `migrations/supabase/018_number_block_registry.up.sql` | **you, SQL editor** |
   | 19 | `migrations/supabase/019_close_rls_auto_enable.up.sql` | **you, SQL editor** |

   Paste each file **whole**. **Never through a script that splits on semicolons** — `003`, `009`,
   and `011`–`019` contain `$$`-quoted bodies with semicolons inside, and a splitter shreds
   them. The seventeen by-hand files are the ones the MCP tools refuse, because they contain `drop` or `revoke`
   (§6a.2).

   **Never re-run `005` after `009`.** 005 re-adds its two-type factory CHECK, the one 009 replaced
   with a trigger. With raw-material rows already in the log it fails and rolls back. Before any
   arrive, it **succeeds**, and every raw-material log insert after it is refused. Detector:
   verification check 2. If it ever fails, re-apply `009`.
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
5. **Mirror the master data** the devices will reference: `product_variants` (with their ids
   unchanged — see step 10 below for why), and, per computer, its `workstations` row and the
   `operators` it names. The source is **test** (`supabase-test`), which was seeded from the host
   PC. The agent lists the rows to be copied, **the owner approves the list** (test may hold
   rows made only for testing), and then the agent inserts them into production. Plain inserts,
   so the tool accepts them. **Once the real database exists, this step does not apply:** production's
   master data then comes from that database's backfill (§10.7), never from test (§10.8).
6. **Verify.** Run `migrations/supabase/verify_applied_state.sql` whole. **Every row must show
   `ok = true`.** It includes the 003-after-005 detector and the full client grant surface. Run it
   against **test first**: test's state is known good, so a failure there is a fault in the script,
   not the project. Then check Advisors in the dashboard against the list in §6a.2. Anything not
   on that list is a finding.

### 7.2 Cloud, once per computer

7. **Create one Auth user per PC** (Authentication → Users → Add user). **One account per
   computer, not per person.** Record each email; the password is needed once, on that machine's
   first sync, and never again.
8. **Create the `workstations` row first**, including its `device_id` — migration 006 adds a
   composite foreign key, so enrolment fails without it.
9. **Enrol the device account:**
   ```sql
   insert into device_accounts (auth_user_id, factory_id, workstation_id, device_id, label, is_active, enrolled_at)
   values ('<auth user uuid>', 'factory-777', '<workstation id>', '<device id>', '<where it stands>', true, now());
   ```
   `device_id` and `workstation_id` must match that computer's own `device-identity.json`
   **exactly**. Either column left null is refused as `BINDING_INCOMPLETE`, deliberately.
10. **Provision the master data each PC will need** — its `operators`, and the `product_variants`
   whose cartons it will push. None of this synchronises; a computer meeting a carton for a
   product it does not have refuses it visibly rather than inventing one.

   **PC 2 must receive its product variants from the cloud or from the seed
   (`productVariantSeed.ts`) — never by creating them in the Product form.** The 36 variants on
   the host were minted with `crypto.randomUUID()` before ids were derived (2026-10-23), so
   re-creating one of those through the form produces a *different* id for the same product. The
   cloud holds `product_variants` under `UNIQUE (article, color, size)`, so the second id is
   refused `VARIANT_IDENTITY_CLASH` and every carton of that product is refused with it.

   Products created *after* 2026-10-23 derive their id from article + colour + size, so two PCs
   creating the same new product converge on their own and the form is safe for those. The rule
   above exists for the 36 that predate it — and `VARIANT_IDENTITY_CLASH` is what tells you the
   rule was broken, rather than letting it pass silently.

### 7.3 On each office PC

11. **Set the four cloud variables** in the environment the app starts in:
   `ERP_SUPABASE_URL`, `ERP_SUPABASE_ANON_KEY`, `ERP_DEVICE_EMAIL`, `ERP_DEVICE_PASSWORD`.
   After the first successful sync the refresh token is stored encrypted in
   `device-credential.bin` and the email and password are no longer needed — the URL and key
   still are.
12. **Set `ERP_UPDATE_TOKEN`** (§5), or that PC will never receive a new version.
13. **Assign the document-number range** in Settings → Document Number Range. The PC holding the
    existing documents presses **adopt** (range 1); every other PC is given 2–5 by an
    administrator, from your written record. **Until this is done that PC cannot create a
    numbered document or print a QR label** — scanning, production, dispatch and store work are
    unaffected, and it now says so at sign-in rather than at the printer.
14. **Install from a fresh installer. Never copy the data folder** between PCs — it carries
    `device-identity.json`, and both machines would then claim to be the same workstation.

### 7.4 On the developer PC

15. **Set `GH_TOKEN`** (§5) in the release terminal only.
16. **Ship the first build that contains the updater:** `npm run release` from a clean tree.
17. **Install that build by hand on every office PC.** The 0.3.1 currently installed contains no
    updater and will never update itself. This is a one-time round of the building; every
    release after it arrives on its own.

### 7.5 Then, and only then

A two-PC test is possible. Watch the **Other Computers** indicator in the navigation rail on both
machines rather than the logs: scan a carton on one and it should reach the other within about a
minute (the pass interval since 2026-10-25), or immediately on **Send Now**.

### 7.6 Enrolling a PC in production: PC 2 (moving from test), and PCs 3–5

**Precondition: production is set up and verified** — §6a.1 steps 1–11 all ticked.

**Today's PC2 (2026-10-31).** Written on 2026-10-23 for an earlier "PC 2" that had been on test.
Today's PC2, the store machine (`47c0dace…`, DESKTOP-R1V8, running 0.4.0), was **never enrolled on
test**: its identity is in neither test table, and it matches the workstation row in its own
database. So A–C apply, D is covered by 0.4.0 and by the clean-up (§10.5), and F does not apply.
A and B were done on 2026-10-31. **C waits for the cutover** (§10): PC2 is not given production
credentials before its test-era state is cleared and the paper baseline exists.

**This is the interim procedure** (owner, 2026-10-23) until in-app enrolment (`docs/37 §U.1`)
replaces it. The same steps enrol **PCs 3–5**, which were never on test: A, B and C apply as
written, and D and F do not apply. **Who does what:**

- **The owner** reads the identity off the PC (step A) and creates its Auth user in the dashboard
  (B.1). This is the one dashboard step left: neither MCP server can create auth users.
- **The agent** writes the `workstations` and `device_accounts` rows through `supabase-prod`
  (B.2, B.3), then confirms the enrolment by query (E).

**PC 2 keeps its identity.** Its `device-identity.json` is not regenerated, its data folder is
not copied or reset, and no new device id is minted. Production is told about the identity PC 2
already has, the same way test was.

**A. Read PC 2's identity** (on PC 2, nothing changes):

`%LOCALAPPDATA%\777-erp\device-identity.json` holds `deviceId`, `workstationId`,
`workstationCode` and `workstationName`. Copy all four exactly. The agent also reads PC 2's
`workstations` and `device_accounts` rows from **test**, and the two must agree. If they do not,
stop: something has re-minted the identity, and that has to be understood before anything is
enrolled.

**B. Production, once (owner and agent):**

1. **Create PC 2's Auth user** — dashboard → Authentication → Users → Add user, in the
   **production** project. **By hand**: the MCP servers have no auth-admin tool. A new email,
   because the test user belongs to the other project. Record the email and the user's UUID. The
   password is needed once, on step C.
2. **Insert PC 2's `workstations` row** with PC 2's own `workstationId`, `workstationCode`,
   `workstationName` and `deviceId` (agent, `execute_sql`). This comes before enrolment: 006's
   composite foreign key refuses an enrolment whose workstation and device do not match a row.
3. **Enrol it** (agent, `execute_sql`):
   ```sql
   insert into device_accounts (auth_user_id, factory_id, workstation_id, device_id, label, is_active, enrolled_at)
   values ('<prod auth user uuid>', 'factory-777', '<PC 2 workstationId>', '<PC 2 deviceId>', 'PC 2', true, now());
   ```
4. **Mirror the operators PC 2 names** (§7.1 step 5), if there are any.

**C. On PC 2 — close 777 ERP first, then change the four variables** (System Properties →
Environment Variables, user scope):

| Variable | New value |
|---|---|
| `ERP_SUPABASE_URL` | `https://ykhvbmhmeefdtrzqeoxm.supabase.co` |
| `ERP_SUPABASE_ANON_KEY` | production's **publishable (anon)** key. **Never the `service_role` key.** |
| `ERP_DEVICE_EMAIL` | the production Auth user's email from B.1 |
| `ERP_DEVICE_PASSWORD` | its password |

**All four must be set, the password included, even though PC 2 already holds a credential.**
`device-credential.bin` still holds the **test** project's refresh token. The credential does not
record which project it belongs to, so on the first pass PC 2 offers the test token to
production, production refuses it, and the app falls back to the password. That sign-in
overwrites the credential with production's. Without a password there is nothing to fall back to,
and the pass fails with "no cloud credential and no device password".

Then sign out of Windows and back in, or restart, so the app starts with the new environment.

**D. The pull cursor must start from zero on the new project.** PC 2's position in the log
(`sync.pull.cursor` in `app_settings`) is a position in **test's** `sync_event_log`. Production's
log starts again at 1, and the cursor is not tied to a project, so PC 2 would silently skip
production's first events, up to its old test position. Harmless while PC 2 is the only device
pushing to production. **Real loss as soon as a second device does.**

**Automatic in builds from `feat/replication-phase-1` onward (2026-10-25):** the project is recorded
beside the cursor (`sync.pull.project`). A cursor recorded for another project, or with no project
recorded, is reset to zero, along with any recorded wait, before the first fetch, and `app.log`
says so (`pull-cursor`). **Releases up to and including 0.3.6 do not have this.** A PC moved on one
of those still needs its cursor and `sync.pull.deferred` cleared before a second device is enrolled
in production.

**E. Confirm, by query, not by the rail:** PC 2's `device_accounts` row shows a fresh
`claim_epoch` and a recent `last_seen_at`. A carton scanned on PC 2 appears in production's
`qr_master` and `sync_event_log`. After the first successful pass the log says "This computer's
cloud credential was stored". **Then remove `ERP_DEVICE_EMAIL` and `ERP_DEVICE_PASSWORD`** from
PC 2's environment (§5a).

**F. Retire PC 2's test enrolment** — `update device_accounts set is_active = false, revoked_at = now()`
for its row in **test**. A PC that is later misconfigured back to the test URL is then refused
rather than quietly writing there.

**What does not move.** Work PC 2 already pushed to test stays in test. Its outbox rows are
`SYNCED`, so they are not sent again. If any of it belongs in production, that is the backfill
(`docs/37` Part 2), a decision rather than a side effect of this move.

### 7.7 Open items from the production move

| Item | Why it matters | Status |
|---|---|---|
| Key the pull cursor by project | A project change silently skips events up to the old position (§7.6 D) | **Done on `feat/replication-phase-1`** (2026-10-25), not yet released: `bindPullCursorToProject` in `packages/sync/src/pullCursor.ts`, called by `SyncPull` with the configured URL |
| Record the credential's project | A stale token is offered to the wrong project once per move. Harmless, because it falls back, but it costs one failed sign-in | Open, low |
| `migrations/supabase/README.md` | Still says 005 and 006 are unapplied. True of no project now | Open |

### 7.8 Write leases: granting, handing over, taking over

From the release that carries local migration 093 (`feat/replication-phase-1`, not yet released), a
PC that is **set up for cloud sync** writes the raw material store and master data **only while it
holds that domain's lease**. A PC that is not set up for sync is unaffected and writes as before.
The cloud enforces the lease with migrations 011–013, and the PC's own gate (`leaseGuard.ts`)
refuses the write first, with a message naming who does write it.

**Before that release reaches a synced PC, grant it the leases it needs.** Otherwise, on its first
pass, it learns that it holds nothing, and its store and material screens refuse every write. In
phase 1, one PC holds both domains (docs/37 W.1). Find the device id in its `device_accounts` row,
then run this in the SQL editor of the project it syncs with (the agent can also run it through MCP
on your word):

```sql
select public.grant_domain_lease('RAW_MATERIAL_STORE', '<device id>', 'Store PC -- <person>');
select public.grant_domain_lease('MASTER_DATA', '<device id>', 'Store PC -- <person>');
select domain, holder_device_id, holder_label, epoch from public.domain_leases order by domain;
```

The PC picks the grant up on its next pass, which takes up to a minute, or immediately with
**Sync Now**.

**Handing over** (docs/37 W.3): the old holder syncs until its queue is empty, then the new holder
is granted. Granting a held domain to another PC is a **takeover**. It is recorded as one, with a
barrier at the old holder's last write, and the new holder will not write until it has pulled past
that barrier. Anything the old holder had not pushed is refused when it does push, and appears in
its dead letters: visible, never merged.

**A PC that shows "not yet learned who writes …"** has never completed a pass against its current
project. Connect it once and press Sync Now.

**A project without 011** (production, until §6a.1 is done) answers that it has no leases. A PC
syncing with it writes the store and master data as it did before leases, and that work waits,
unsent, for the backfill. This is deliberate: an unapplied migration must not lock the store.

### 7.9 Sending the store PC's history (the backfill), once

Everything the store PC wrote **before** it started syncing has never been sent: materials,
categories, units, parties, machines, work sections, stock movements, and label runs. A new PC
fills its stock from the cloud alone, so this has to go up once, after the leases are granted
(§7.8).

1. On the **store PC**, signed in as an administrator, open **Settings → Cloud Sync → Send This
   Computer's History**. It lists what will be sent. Nothing has been sent yet.
2. **If it lists materials whose stock does not add up, stop.** For each one, the recorded movements
   do not add up to its stock (or one is in another unit). Sent as it is, every other PC would show
   a different number. Decide what each should be, correct it on the store PC, and reopen the
   panel. The button stays off until the list is empty.
3. Press **Send History** and confirm. Nothing is sent at that moment: everything is *marked*, and
   the ordinary syncs send it over the next minutes, materials ahead of their stock.
4. Watch it arrive on the other PC. Its stock screen marks each material still arriving, and the
   app-wide notice appears only if something waits over an hour.

Sending again is safe: a movement, run or packet already sent is a duplicate everywhere, and a
master record just travels as its next revision. Any other PC is refused: it does not hold both
leases.

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

### 9a. The installer must stay ONE-CLICK, or updates cannot install themselves

`electron-builder.yml` sets `nsis.oneClick: true`. **Do not change it back**, and do not add
`allowToChangeInstallationDirectory` (electron-builder refuses the combination outright:
*"allowToChangeInstallationDirectory makes sense only for assisted installer"*).

An **assisted** installer shows a wizard that somebody has to click through. `electron-updater`
quits the app and launches the installer, but it cannot answer the wizard's pages — so the app
closes, a prompt appears, and **nothing is installed**. It fails silently: the log says the
update is installing, and the next startup reports the old version.

That is exactly how 0.3.3 failed on this machine on 2026-10-23, with `oneClick: false`:

```
20:22:01Z  update   "Restarting to install version 0.3.3."
20:22:07Z  update   "<user> restarted 777 ERP to install a downloaded update."
20:23:15Z  runtime  build-provenance  v0.3.2        <- still the old version
```

Nothing was wrong with the download — the pending installer was on disk, intact, and reported
version 0.3.3. Only the install could not complete without a person at the keyboard, which
defeats the whole point of the updater.

`updater.ts` calls `quitAndInstall(true, true)` to match: silent, and start the new version
afterwards. The defaults are `(false, false)`, which show the installer's UI and leave the app
closed. Both halves are needed, and both depend on the one-click installer.

**What this gives up:** the install folder can no longer be chosen. It goes to
`%LOCALAPPDATA%\Programs\777 ERP`. For four workstations installed once each, that is worth an
update path that needs nobody present.

**How to tell an install really happened** — never trust the prompt, check the version:

* Settings shows the running version, or
* the newest `build-provenance` line in `%LOCALAPPDATA%\777-erp\logs\app.log`, or
* right-click `%LOCALAPPDATA%\Programs\777 ERP\777 ERP.exe` → Properties → Details.

If the version did not change, the update did not install, whatever the app said.

---

## 10. Cutover: bringing the real database onto production

**Status: PROCEDURE, NOT YET RUN.** Written 2026-10-23, before the day, so that nothing on the day
is improvised. The real database arrives from **PC 2**. Everything built and tested up to then ran
against the **test** project (`wpkrhgqsizjjdaztijwv`) using a snapshot. On cutover day the real
database goes to **production** (`ykhvbmhmeefdtrzqeoxm`), and test data never does.

Do the steps **in this order**. Each one says what to record, because the record is how you prove
the step happened and how you go back if a later step fails.

### 10.0 Before the day

1. **Production is set up and verified** (§6a.1, steps 1–12). Its business tables are empty.
2. **The release that will run in production is built and installed on the developer PC**, and
   **the whole procedure below has been rehearsed on a copy** of the real database in a dev data
   folder (`ERP_DATA_DIR`), pointed at **test**. If the rehearsal changes any row count other
   than the ones step 10.3 says may change, stop and find out why.
3. **The paper baseline exists** (`docs/35` step 2): stock per material, open gatepasses, party
   balances, written down from the books. Without it there is nothing to check the result against,
   and the cutover is not authorised to proceed.

### 10.1 Freeze and copy

1. **Stop work on PC 2. Close 777 ERP**, and confirm in Task Manager that no `777 ERP.exe` is
   running.
2. **Copy the whole data folder** `%LOCALAPPDATA%\777-erp` to removable media, as an archive
   that is never opened again: the **untouched original**. Copy the database **with** its
   `-wal` and `-shm` files. A database copied without its `-wal` loses its most recent work.
3. **Record, from the copy:** `PRAGMA quick_check` (must be `ok`), the latest `schema_migrations`
   version, `app_settings` `device.id`, `numbering.block` and `numbering.block.confirmed`, the
   `workstations` rows, and row counts for every business table. The agent's read-only inspection
   script does this without writing anything.

### 10.2 Device identity — check, never invent

The real database belongs to the machine whose `device-identity.json` sits beside it.

1. **Read PC 2's `device-identity.json`**: `deviceId`, `workstationId`.
**No longer applies (checked 2026-10-31).** 087 was changed before release to stamp the running
computer's own id, bound from `device-identity.json`, not `'desktop-main'`. Copies of PC2's and
PC3's files show PC2's id on the pre-existing numbered rows, and the app rewrites `device.id` from
`device-identity.json` on every start, so a database carried over from PC3 takes PC2's id when it
starts on PC2. Step 1 below still applies; step 2 is kept for the record.

2. **Check it against migration 087's hard-coded stamp.** 087 stamps every pre-existing numbered
   row with `origin_device_id = 'desktop-main'`, and seeds `device.id = 'desktop-main'`. That was
   right for the original installation. **If PC 2's `deviceId` is not `desktop-main`**, 087 has
   attributed (or will attribute) PC 2's own documents to another computer. Numbering then
   cannot see its own stray numbers, and every replicated document would carry the wrong origin.
   **Stop:** a corrective migration (re-stamping `desktop-main` to PC 2's id, on that database
   only) must be written, reviewed and rehearsed first. Do not hand-edit the database.
3. **The database stays with its identity.** If it runs on PC 2, keep PC 2's data folder exactly
   as it is. If it must run on a **different** machine, that machine mints its own identity, gets
   a new `workstations` row, and is enrolled as itself (§7.6). **Never copy `device-identity.json`
   or `device-credential.bin` to another machine.**

### 10.3 Migrations

1. **Install the production release on the machine that will run the database**, then start it
   once. On launch the app takes a **pre-migration backup** (a `database-backup` line in
   `app.log`), then applies every missing migration in order, up to the release's ceiling.
2. **Verify:** the latest `schema_migrations` version equals the release's ceiling, `quick_check`
   is `ok`, and **business row counts are unchanged** from 10.1. Migrations 087–090 add columns
   and rebuild `sync_outbox`, and move no business row. The only expected changes are in
   `sync_outbox`'s shape and in `app_settings` (`device.id`).
3. **If it fails:** do not patch. The pre-migration backup and the untouched original are the way
   back (§4b).

### 10.4 Number block

1. **The real database keeps its block.** If it has been issuing documents, that is **block 1**,
   confirmed (`numbering.block = 1`, `numbering.block.confirmed = 1`). Never change it on this
   database.
2. **Record the written assignment:** block 1 = this database's machine, and blocks 2–5 = the
   others (§7.3 step 13). A PC enrolled later is given its block from that record, never block 1.

### 10.5 Clear what belongs to the test project

The database may have talked to test during the pilot. Anything it remembers about test must go
before it talks to production. **All of this is per-PC state** (`replicationScope.ts`), and none
of it is business data:

1. **The pull cursor and any recorded wait** (`sync.pull.cursor`, `sync.pull.deferred`). They are
   positions in test's log, and production's log starts at 1 (§7.6 D).
2. **Queue rows already marked `SYNCED`** — they were sent to **test**. Left in place, their dedupe
   keys block the production backfill from queueing the same facts again, so production would
   silently never receive them. Delete them. The facts are in the business tables, and the
   backfill re-derives them.
3. **The 868 legacy `PRODUCTION_EVENT` rows** (`docs/37 §2.1`): retire them, as planned there.
   Never push them.
4. **`device-credential.bin`** holds a test-project token. It is replaced on the first production
   sign-in (§7.6 C), so it needs no action. Removing it is harmless.

How: by an admin action in the release, or by the agent with the app closed, through a reviewed,
rehearsed script. **Never by hand-typed SQL on the day.**

**The script: `scripts/clear-test-state.mjs`** (`packages/data/src/database/testStateClear.ts`).
It works on a copy and writes a new file; the copy it is given is hashed and never written. It
deletes queue rows already sent (`SYNCED`), **retires** the 868 legacy rows (marks them `SYNCED`
with a note, deletes none), removes `sync.pull.cursor`, `.deferred`, `.project`,
`sync.leases.unsupported` and `sync.backfill.last`, and empties the lease cache. It keeps queue
rows written since without a lease epoch, which the backfill re-queues. It **refuses**, changing
nothing, on another computer's database, a schema other than 0.4.0's (099), and anything it was not
built for: rows stamped with a lease epoch, rows in flight, failed or dead-lettered, events parked
from test's log, displaced names. Then it checks: nothing sent is left, every legacy row is retired,
only those settings went, the lease cache is empty, **every other table holds exactly the rows it
did**, `quick_check` ok. A failed check renames the output `*.FAILED`.

**Rehearsed 2026-10-31** on PC2's 27 Oct file, upgraded to 099: 2 sent rows deleted, 868 retired,
`sync.pull.cursor` removed, 107 other tables identical; a second run changed nothing; the result
opens at 099 and its backfill plan shows **0 stock mismatches** (1,073 master records, 6,788
movements, 1,134 label runs, 5,002 packets, 31 products). **The real run** is the same command on a
fresh copy of PC2's database taken with 777 ERP closed (with its `-wal` and `-shm`), then the
output swapped into PC2's data folder, before step C of §7.6.

### 10.6 Production enrolment and leases

1. **Enrol the machine** in production (§7.6 A–C), keeping its identity.
2. **Grant it the leases it holds:** Raw material store and Master data. **Not Accounts** (owner,
   2026-10-31): PC2 is the store and raw material stock only, so its party ledgers stay hidden.
   Record who granted them, and when.
3. **Point its four variables at production** (§7.6 C). Remove anything pointing at test.

### 10.7 Backfill and verify

1. **Run the backfill** (the "send existing data" action) on the holder. The Health page shows the
   queue rise, then drain to zero.
2. **Verify in production, by query:** row counts per replicated table equal the local counts
   from 10.1. `verify_applied_state.sql` still passes, because the backfill adds rows and changes no
   grant.
3. **Bring up a reader** (a PC enrolled without a lease) and compare **Store In → Stock**
   material by material with the holder. Zero differences, or stop.
4. **Compare against the paper baseline** (`docs/35` step 5). The application is checked against
   the books, never against memory.

### 10.8 What never happens on cutover day

- **Test data never enters production.** Production's master data comes from the real database's
  backfill, never from test. This supersedes §7.1 step 5's "mirror from test", which applies only
  while production has no real database.
- **No PC holding real business data is ever pointed at test** once raw-material pull is
  released. A reader pulls everything in the log, and test holds snapshot data that would be
  written into the real database.
- No hand-typed SQL, no copied data folders, and no skipped verification.
