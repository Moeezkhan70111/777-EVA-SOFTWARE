# 44 — Carton Cloud release: go-live runbook

Carton Stock, Gatepass, Billing and Cash Vouchers on the production cloud (`ykhvbmhmeefdtrzqeoxm`). Every existing
local stock and financial record stays off it. Accounts stay LOCAL. Raw Material Stock is unchanged.

**The one rule.** Every stock and financial document in every local database is TEST DATA, including anything made on
this release before Carton Cloud is activated on that computer. It is never sent, and after activation it counts in no
balance. Code: `packages/data/src/database/stockProtection.ts`.

---

## 1. What the release enforces

| Protection | Behaviour |
|---|---|
| **Off by default** | Opening a database never activates anything. While Carton Cloud is off, no carton movement, Manual Production entry, gatepass, bill or cash voucher is built, queued or sent. |
| **Activation** (Settings → Cloud Sync → Carton Cloud, administrator, once) | Records a sealed **cutoff**: the highest row number in each stock and financial table. Everything at or below it is test data for ever. It is logged with the time, administrator, device, project, cutoff, retired marks and parked events. |
| **Activation is refused** unless | the cloud reports `CARTON_STOCK`, `SALES_DISPATCH` and `ACCOUNTS` (cloud 026–028 applied), each with a holder; the lease cache was read in the last 15 minutes; and this computer's carton store figure holds no test cartons (the fresh start was run). The administrator must also confirm the cloud project shown. |
| **Fail closed** | A missing, unreadable, hand-edited, copied-to-another-PC or other-project activation is NOT active. Nothing of stock is sent. It can never be re-activated, and the cutoff cannot be moved. |
| **Every outbound path checks the cutoff** | the builders, "send again", the lease-return resend, the dead-letter requeue, and the drain's last gate (which parks a queued excluded record as `LOCAL_STOCK_DATA`). The backfill never marks a carton movement, Manual Production entry, gatepass, bill or cash voucher. Raw-material stock movements and label runs are backfilled exactly as in v0.4.6 (Raw Material is unchanged). Carton QR identities and production scans are never sent. |
| **Balances after activation** | Customer ledgers, the customer balance list, the credit-limit balance and contractor pay leave out bills, cash vouchers, sale returns and Manual Production entries made before activation. The rows are kept, the document lists still show them, and nothing is deleted. |
| **Old documents after activation** | Cancelling an old gatepass (`BEFORE_GO_LIVE`), editing, entering or deleting an old bill or cash voucher, and voiding an old entry whose cartons were cleared are all refused. Test data can never move a live figure or a live balance. |
| **Received from the cloud = real** | A document with a cloud revision, or a carton movement received from the cloud, is real however early it arrived. It is never treated as test data, so a PC activated later than another still shows every real record. |
| **Working screens warn until activation** | Manual Production, carton adjustments, gatepasses, bills and cash vouchers show "Carton Cloud is not active on this computer" on every syncing PC until it is activated, because anything saved there before then stays local for ever. The warning also shows if the activation is invalid or its state cannot be read. |
| **Receiving is unchanged** | Everything the cloud sends applies normally, before and after activation. |
| **Cloud ahead of the release** | A product master record refused as `UNKNOWN_RECORD_TYPE` (cloud 028 not yet applied) waits and goes once it is applied. It is never parked. |

---

## 2. Final migration sequence

**Local SQLite**, automatic at the release's first start, after a pre-migration safety copy, in one transaction: any of
`100 101 103 104 105` the database has not recorded. A v0.4.6 database is at 102 without 100 and 101; those run too.
Proven from every release level (v0.1.0 to v0.4.6) by the upgrade harness.

**Cloud**, production is at 019: `026_carton_stock_events` → `027_carton_stock_adjustments` →
`028_production_to_cash_records`. `020`–`025` (Cloud Accounts) are not applied and not needed. The carton functions
authorise by device account only, so they work in LOCAL accounts mode (`verify-cloud-independence.mjs`: ALL PASS).

---

## 3. Production procedure (in this order)

| # | Step | Where | Gate to the next step |
|---|---|---|---|
| 1 | Cloud rehearsal (§4) | **done 9 Nov 2026**: local PostgreSQL 17, 20/20 | stages 10–50 all pass |
| 2 | Genuine upgrade rehearsal (§4) | **done 9 Nov 2026** on this laptop's own database (v0.4.0, 27/27); PC2's copy optional | every check passes |
| 3 | Cloud 026 → 027 → 028 on production, then verify (§5) | production SQL editor | stage-41 checks ok |
| 4 | Assign the three leases (§6) | production SQL editor | each domain has its holder |
| 5 | Publish the release. PCs auto-update; Carton Cloud is off on every one | release process | each PC starts, signs in locally |
| 6 | **Isolate local test data** on every PC: settle test gatepasses, then the carton fresh start (§7) | each PC, app closed for the swap | fresh-start checks all pass |
| 7 | **Activate Carton Cloud on every PC**, writers *and* readers (PC3), before the first real transaction (§8) | each PC | the panel shows "On since …"; no working screen shows the not-active warning |
| 8 | First real transaction checklist (§9) | holders, then every PC | every box ticked |

Real carton or money work must not start before step 7 on every PC. Before activation such work is test data by
definition, and it is never sent.

---

## 4. Rehearsals (`C:\Projects\777-carton-upgrade-rehearsal`)

**Local, synthetic** (done, all ten release levels): `node rehearse-upgrade.mjs`.

**Local, genuine** (done 9 Nov 2026, **27/27 PASS**): this development laptop's own installed database.
- Device DESKTOP-416CVSH (`c8114632-…`), installed v0.4.0, migration 099, no business rows.
- The source was copied as bytes (the app was closed and there was no `-wal`), then copied again with `VACUUM INTO`;
  the original's hash is unchanged.
- Evidence: `results\genuine-upgrade-laptop-DESKTOP-416CVSH-v0.4.0-2026-11-09.txt`.
- It is this laptop's database, not PC2's.

Optional before go-live: the same run on a VACUUM INTO copy of PC2's database (`C:\Projects\777-pc2-inspection`,
read-only), then `node rehearse-upgrade.mjs --source <copy> --out <folder allowed to hold business data>`. The harness
refuses a live file and proves the source unchanged.

**Cloud: done on a throwaway local PostgreSQL 17, 9 Nov 2026, 20/20 PASS** (`run-local-cloud-rehearsal.mjs`;
evidence in `results\cloud-rehearsal-local-pg17-2026-11-09.txt`). No third Supabase project exists, and branching
would change a settings value on production or TEST, so it was not used. Proved:
- production's base (schema.sql, 002–019) verifies 35/35, without Cloud Accounts;
- 026–028 apply;
- carton movement writes (lease, duplicates, refusals, log);
- the four stock documents each land only under their own lease;
- 028's types, lease domains, RLS and grants, with the raw-material functions intact;
- rollback to 019 (35/35 again), then a clean re-apply and every check again;
- both guards refuse.

The platform layer (`local-pg\00_supabase_platform.sql`) recreates only what a new Supabase project has, using the
default grants migration 010 recorded on the real project. Steps are in `README.txt` B0.

What is not covered locally: PostgREST and Supabase Auth themselves. The RPCs are called with the same JWT claims
PostgREST sets. The first real transaction (§9) exercises the real path.

**On a Supabase project instead** (only if one is ever available, never production or TEST). What is needed, exactly:

- A **brand-new Supabase project** in the factory's organisation, made only for this (name it `carton-rehearsal`),
  region as production. No other configuration. It is deleted afterwards.
- Dashboard access to its **SQL editor** and **Authentication → Users**. No keys, CLI or local software are needed:
  the stages are pasted. To have the agent run them instead, add that project's own MCP server to `.mcp.json`, scoped
  to its project ref, and never reuse `supabase-prod` or `supabase-test`.
- `Get-FileHash -Algorithm SHA256 cloud\*` must match `cloud\SHA256SUMS.txt` (verified 9 Nov 2026; the sources match
  `cloud\SOURCES-SHA256.txt`).

Then follow `README.txt` section B: 10 base (with self-guard) → 15 verify (35/35) → 20 stand-in device → 30 apply
026–028 → 40 carton movements → 41 grants/RLS/lease domains/no Cloud Accounts → 42 the four documents under their own
leases → 15 again → Advisors → 50 rollback → 15 → 30, 40 and 42 again (re-apply) → delete the project.

---

## 5. Cloud migrations on production

1. SQL editor of **ykhvbmhmeefdtrzqeoxm** (check the address bar). Pasted by hand: the MCP write tools refuse `revoke`.
2. Paste `migrations/supabase/026_carton_stock_events.up.sql`, then `027_…`, then `028_…`. Stop at any error and
   record it verbatim.
3. Verify with `cloud\41_check_028_and_grants.sql` with its first `do $$ … $$;` guard block removed. The guard looks
   for the rehearsal marker, which production does not have. It is read-only. Every row must be ok: no carton movement
   yet; the `CARTON_STOCK` lease held by nobody yet (run before §6); Cloud Accounts absent.
4. `verify_applied_state.sql`: exactly checks **3, 20, 22 and 29** may now differ from expected, as in the rehearsal:
   - 3: +1 table, `carton_stock_events`;
   - 20: the new aggregate types;
   - 22: +`CARTON_STOCK`;
   - 29: 028's leased record types.

   Any other failing row is a finding: stop.
5. Advisors as in docs/36 §6a.2. Record the applied set in docs/36 §6a.1.

---

## 6. Lease assignment

```sql
select public.grant_domain_lease('CARTON_STOCK',   '<device id>', '<PC> -- Manual Production');
select public.grant_domain_lease('SALES_DISPATCH', '<device id>', '<PC> -- Gatepasses and bills');
select public.grant_domain_lease('ACCOUNTS',       '<device id>', '<PC> -- Cash vouchers');
select domain, holder_device_id, holder_label, epoch from public.domain_leases order by domain;
```

Device ids are in `device_accounts`. One holder per domain. Handing over follows docs/36 §7.8. A PC picks up a grant on
its next pass (Sync Now).

**Sale returns belong to the `SALES_DISPATCH` holder**, enforced in code (`leaseChannels.ts`: `returnScan` is leased to
`SALES_DISPATCH`; every other syncing computer refuses it). Returns are not sent to the cloud in this release (§11), so
the customer ledgers on the computer where bills are entered include them. **In this release returns are paused
everywhere**: returns are QR scans, and carton QR is on hold (`CARTON_QR_ON_HOLD`). The rule takes effect, without
any further change, when the hold is lifted. The Return Carton screen states both.

---

## 7. Per-PC: upgrade and local test-data isolation

1. **Record the PC's version before the update** (Settings → About). Do not assume it.
2. **Never install v0.1.0 or v0.2.0 over an upgraded database.** They have no newer-database guard. v0.3.0 and later
   refuse it (proved).
3. **A PC that has synced carton documents with TEST** (PC1, the W1/W2 rehearsal databases) must not be pointed at
   production as it is. Its TEST revisions would read as "from the cloud". Give it a fresh database.
4. Start the release once. The safety copy is written to `<data folder>\backups\erp-premigration-<from>-to-105-<time>.sqlite`.
   Sign in with the same local username and password.
5. **Settle test gatepasses**: cancel the live ones (allowed before activation).
6. **Carton fresh start**, app closed, on a copy, as `scripts/reset-carton-stock.mjs` says (`--db <copy>`, then
   `--db <copy> --out <new> --apply`, and swap in only if every check passes). Test movements made on this release do
   not stop it; they stay as history, never sent. It refuses after activation, or if any movement came from the cloud.
7. Test bills and cash vouchers need **no** clean-up and nothing is deleted. Activation takes them out of every
   balance.

---

## 8. Activation (every PC)

1. Sync Now. Settings → Cloud Sync → **Carton Cloud** lists no problems and shows who holds each lease.
2. The confirmation shows the **cloud project**: it must be production.
3. Activate. Keep a screenshot of the "On since …" line. The log entry (`sync` / `carton-cloud-activation`, WARNING)
   holds the cutoff.
4. Activate readers too (PC3). Activation needs no lease of its own, and it takes that PC's test documents out of its
   balances.

---

## 9. First real production transaction: checklist

- [ ] CARTON_STOCK holder: one Manual Production entry. Its figure rises.
- [ ] Sync Now. On the Health page nothing is parked except `LOCAL_STOCK_DATA` test events.
- [ ] Production: `select count(*), min(created_at) from public.carton_stock_events;` shows exactly 1, after the activation time.
- [ ] Another PC: the figure rises by the same cartons within a minute, without a restart.
- [ ] SALES_DISPATCH holder: a gatepass. The figure falls on both PCs, and its bill appears.
- [ ] ACCOUNTS holder: a cash voucher. The customer's balance moves once, on both PCs, by exactly that amount. No
      pre-activation document appears in that customer's ledger on any PC.
- [ ] A double-pressed Save makes one document.
- [ ] No working screen on any PC still shows "Carton Cloud is not active on this computer".
- [ ] Return Carton refuses a scan (returns are paused while carton QR is on hold), on every PC.
- [ ] Production: `select aggregate_type, count(*) from public.sync_event_log where created_at > '<first activation time>' group by 1;`
      lists only today's real records. `select count(*) from public.leased_records where aggregate_type in
      ('GATEPASS','SALE_VOUCHER','CASH_VOUCHER','MANUAL_PRODUCTION_ENTRY');` equals the documents made since go-live.

If any box fails: stop carton and money work on every PC, keep the logs, and do not activate further PCs.

---

## 10. Rollback and recovery

| Situation | Action |
|---|---|
| A local upgrade fails at start | Nothing is half-migrated (one transaction). The error names the safety copy, which holds every row (proved at every level). Fix forward (docs/36 §4a), or restore that copy under the previous version (§4b). |
| The release must be withdrawn after PCs upgraded | docs/36 §4b: the previous version plus its pre-migration copy. Work since is lost. v0.3.0 and later refuse the upgraded file, so nothing is damaged by mistake. |
| Cloud 026–028 must be undone | `028`, `027`, `026` `.down.sql`, in that order (rehearsed in stage 50). Only while the cloud holds no carton movement or stock document, i.e. before §3 step 7. |
| Activation shows **NOT valid** | Nothing of stock is sent, and balances still use its cutoff. Do not edit `cloud.cartonActivation`. A moved or copied database needs a deliberate decision: the application has no way to reset a cutoff. |
| A wrong PC was activated, or activated too early | The cutoff stands. Records made before it stay local test data, which is the safe direction. Nothing old can be sent. |
| Test data appears in the cloud | Stop all sync at once and report with the PC's log. It is blocked on every path, so this means a defect. |

---

## 11. Known limits

- **Sale returns: paused in this release** (they are carton QR scans, and carton QR is on hold). When the hold is lifted
  they are recorded only on the `SALES_DISPATCH` holder (enforced by its lease; decided 9 Nov 2026). They are not sent,
  so other PCs' customer balances will not include them. Return replication is a later release.
- Synthetic rehearsals prove every release *schema*. A genuine copy proves real data: this development laptop's own
  installed database (v0.4.0, migration 099, DESKTOP-416CVSH; it holds no business rows) passed 27/27 on 9 Nov 2026.
  PC2's data itself has not been rehearsed.
