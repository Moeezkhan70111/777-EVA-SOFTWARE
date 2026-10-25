# 37 — Full replication: every PC holds the whole database

**Status: ADOPTED, PARTLY BUILT.** Written 2026-10-22. Updated 2026-10-23.

- **Scope: full** — every domain replicates. Owner decision, 2026-10-23. `docs/38` (partial scope)
  was not adopted; its §2 (logins stay local) still stands.
- **Write model: single writer per domain** — owner decision, 2026-10-23. See §W. It replaces the
  conflict rules originally proposed for Class D, and changes the estimate (§3).
- **Priority: raw material first** — owner decision, 2026-10-23. Carton production is delayed, and
  the raw material store is the immediate business need. Raw material replicates end to end first:
  its events, its master data and its stock balances rebuilt from events. Cartons and production
  follow (§4).
- **Built:** §0.1 numbering (migration 087), §0.2 exclusion list (`replicationScope.ts`), the
  general applier (`packages/sync/src/applyEnvelope.ts` + `applyContract.ts`), and `replicated_at`
  (migration 088, §0.3). On `feat/replication-phase-1`: the identity-conflict guard, the RM label-run
  contracts on both sides (migrations 089–090), and, from stage 1, the project-keyed pull cursor
  and **parking** (migration 091). A waiting event is now held locally and the cursor moves on, so
  one waiting event can no longer stall the log.
- `docs/34` (carton pilot) is still the live configuration. The two-PC carton test has not been
  recorded as passed.

**Goal, as stated by the owner:** every PC holds the complete database, all domains, kept in
agreement through the cloud. Both machines see the same data, and either one keeps working with
everything if the internet drops.

Grounded in a row-count inventory of the live database taken 2026-10-22: **103 tables, 73
non-empty, ~27,000 rows.**

---

## 0. Two things that block everything else

Neither is a domain contract. Both are prerequisites, and the first is a hard stop.

### 0.1 Document numbering breaks the moment a numbered table replicates

`allocateNumberInRange` (`packages/data/src/database/numberRange.ts`) does this before issuing a
number:

```
const stray = countOutsideRange(db, site, range);
if (stray.count > 0) throw new NumberRangeError("OUT_OF_RANGE", ...)
```

`countOutsideRange` counts **every row in the table** whose number falls outside this computer's
block. Today that is always zero, because a computer only holds its own documents. Under
replication it is never zero: PC 1 holds PC 2's gatepasses, whose numbers are block 2 by design.

**Result: every numbered document creation fails on every PC, immediately.** No gatepass, no
bill, no party, no product.

The fix is to narrow the check from "any row outside my range" to "any row **I created** outside
my range" — which needs an origin column on every numbered table. Measured 2026-10-22:

| Numbered table | Origin column | Rows |
|---|---|---|
| `raw_material_receiving_sessions` | `device_id` ✅ | 165 |
| `raw_material_issue_sessions` | `device_id` ✅ | 109 |
| `store_receiving_sessions` | `device_id` ✅ | 6 |
| `store_move_out_sessions` | `device_id` ✅ | 4 |
| `gatepasses`, `sale_vouchers`, `cash_vouchers`, `purchase_vouchers`, `machine_programs`, `manual_production_entries`, `parties`, `article_sizes`, `party_claims`, `removal_requests`, `stock_correction_requests`, `machines`, `inventory_items`, `work_sections` | **NONE** ❌ | 14 tables |

So: **14 new columns, a backfill stamping existing rows with `desktop-main`, and a change to the
one function that every numbered document in the ERP depends on.** That function is currently
covered by `numberRange.test.ts`; those tests encode the present behaviour and will need
rewriting alongside it.

### 0.2 Three things must be excluded from replication, not merely unhandled

If these replicate, the system breaks in ways that look like data corruption:

| Table | Rows | What happens if it replicates |
|---|---|---|
| `app_settings` | 13 | Holds `numbering.block`. Every PC would be handed the same block and allocate colliding document numbers — the exact failure the block scheme exists to prevent. |
| `qr_sequences` | 35 | Per-PC carton serial counters. Replicating them merges the counters and both PCs issue the same serials. |
| `raw_material_qr_sequences` | 743 | Same, for packet labels. |

`sync_outbox`, `user_sessions`, `schema_migrations`, `system_health_snapshots`,
`backup_history`, `devices` and the PC's own `workstations` row join them: all are statements
about one machine, not shared facts.

**This exclusion list does double duty** — it is also the scrub list for the snapshot backfill in
§2.2. A restored snapshot that keeps `app_settings` hands the new PC block 1.

### 0.3 Timestamps across computers — owner decision, 2026-10-23

**A replicated row keeps the origin's `created_at`, unchanged.** That is the business time: when
the carton was registered, when the packet moved. A receiving PC that rewrote it would make every
report on that PC disagree with the same report on the origin.

**The arrival time is a separate column, `replicated_at`, for diagnostics only.** `NULL` means
the row was recorded on this PC. A timestamp means the applier wrote it here, at that UTC time.
It is never updated, so a repeat arrival keeps the first one's time. The applier stamps it, so
every contract gets it without asking (migration 088 adds it to the first three tables, and each
later contract's migration adds it to its own).

*Named `replicated_at`, not `received_at`:* in this codebase "received" already means raw material
received into the store (`rawMaterialReceiptUseCase`, `RECEIVE` stock events). A `received_at`
column on a raw-material table would be read as a business fact.

**Clocks are verified at setup, never trusted at runtime.** Nothing compares two PCs' clocks to
pick a winner, and the single-writer model (§W) removes the last place that would have: Class D
last-write-wins. But a PC whose clock is wrong still writes wrong business times, and on
2026-10-23 a freshly moved dev PC was found **22h 42m slow and set to Pacific time**, which also
broke TLS to Supabase (`CERT_NOT_YET_VALID`). So every PC's setup includes, as written steps:

1. **Time zone** is `Pakistan Standard Time`: `tzutil /g`.
2. **NTP sync is on and recent**: `w32tm /query /status`. Expect a real `Source`, not
   `Leap Indicator: 3(not synchronized)`, and a `Last Successful Sync Time` from today. To fix it,
   run `w32tm /resync /force` in an admin shell.
3. **Skew against the cloud is under a minute**: compare `Get-Date -AsUTC` (on Windows PowerShell
   5.1, `(Get-Date).ToUniversalTime()`) with the `Date` header of
   `curl -sI https://<project-ref>.supabase.co`.

The steps are in each PC's provisioning checklist (`docs/34`, "Before you start"). A PC that fails
any of them is not enrolled until it passes.

---

## W. Write model — single writer per domain (owner decision, 2026-10-23)

**One holder of the write lease per domain; every other PC reads that domain. QR and carton flows
stay multi-writer**, because their identities are deduplicated by construction (a carton or packet
id is minted from a per-PC serial block, and every row is insert-only).

This is what makes full scope tractable. The hard Class D problems in the original plan, and most
of §1a, were all *two PCs editing the same thing offline*. With one writer per domain that case
cannot arise for leased domains, so there is nothing to merge, no last-write-wins, and no
divergence to surface. Replication of a leased domain becomes: the holder's revisions flow out
and everyone else applies them.

### W.1 The domains

| Domain | Writer | Tables (headline) |
|---|---|---|
| **QR & carton flows** | **any PC** — no lease | `qr_master`, `qr_codes`, `qr_batches`, `production_events`, carton store movements, `store_receiving_sessions`, `store_move_out_sessions` |
| **Raw material store** | lease holder | packet label runs (`raw_material_qr_batches`, `raw_material_qrs`), packet movements (`raw_material_qr_events`), stock movements (`inventory_stock_events`, including Dana hand moves and opening stock), `raw_material_receiving_sessions`, `raw_material_issue_sessions` |
| **Master data** | lease holder | RM items and taxonomy (`inventory_items` + values, categories, fields, options, units, ladders, item unit steps), parties and party groups, machines, work sections, products and classification |
| **Sales & dispatch** | lease holder | gatepasses, sale vouchers, dispatch sessions, sale returns. **One domain on purpose**: bill quantities are locked to the gatepass (`docs/23`), so they must share a writer. |
| **Accounts** | lease holder | cash vouchers, purchase vouchers |
| **Machine programs** | lease holder | `machine_programs` and its child tables, manual production entries |
| **Approvals** | lease holder | stock corrections, removal requests, party claims, access and permission requests |

**The raw material store is leased** (owner, 2026-10-23). An earlier draft treated RM packet scans
as multi-writer QR flows, because packets are minted from per-PC serial blocks. That is now
superseded: receiving, issuing, label runs and Dana moves have one writer. Carton QR flows stay
multi-writer.

**Phase-1 holder: one PC holds both Raw material store and Master data.** Parties are one table
shared by suppliers (store) and customers (sales), so splitting their lease would mean leasing by
`party_type`. That is avoidable while every document still lives on one PC. Revisit when Sales &
dispatch replicates.

**Logins are not a leased domain.** Under §U.2 accounts are cloud-authoritative: they are changed
only by online cloud functions, never by a PC's local write. `app_users` itself, which holds the
hashes, stays excluded from replication (`replicationScope.ts`). Until §U.2 is built, each PC
keeps its own accounts, as before.

### W.2 The lease

- **Held by a PC, on behalf of a named person.** Logins are local, so the cloud cannot recognise a
  person across PCs. It can recognise a device: device accounts and claims (migration 006). The
  lease is bound to a device, and the grant records which person it was granted to.
- **Same mechanism as the device claim** (migration 006): a per-domain row with a monotonic epoch
  and a holder token, taken under a row lock. No timeout, and no clock to agree on.
- **Enforced in the cloud, in the push RPC, in the same transaction as the write.** A push for a
  leased domain from a PC that does not hold its current epoch is refused. This is the authority.
- **Enforced locally in the data/application layer**, not the UI: a write use case for a leased
  domain refuses unless this PC holds the lease, according to the last pull. The UI shows the
  domain read-only. A hidden button is not an authorisation (CLAUDE.md R9).
- **The holder may write offline.** The lease is checked when the writes are pushed, not when they
  are made.

**As built — cloud migration 011 (applied to test and verified 2026-10-25, docs/36 §6a.2).**

- `domain_leases` has one row per domain: holder `device_id`, a label recording who it was granted
  to, and an `epoch` that bumps on every grant, release and takeover. `domain_lease_events` is the
  append-only record of all three.
- **No second token.** The lease names a device, and 006's claim proves which device is calling.
  A copied enrolment cannot borrow a lease, because it cannot hold the claim.
- **Every leased event carries the lease epoch it was written under.** A push RPC calls
  `lease_holds(domain, device, lease_epoch)` after `claim_is_current`, in the same transaction,
  under a row lock. The device alone is not enough. If a lease went A → B → A, A's unpushed writes
  from its first tenure would land on top of B's. With the epoch they are refused and park in A's
  dead letters (W.3).
- **Granting is owner-only:** `grant_domain_lease` is executable by no client role. Until U.2 the
  cloud knows machines, not people, so it cannot tell an administrator from a storekeeper. Leases
  are granted from the SQL editor, or by the agent through MCP on the owner's word, just as
  enrolment is. A device can read leases (`current_leases`) and release its own
  (`release_domain_lease`), never take one.
- **Catch-up barrier.** Release and takeover record `barrier_seq`, the last log position the
  previous holder wrote. The new holder's computer refuses its own writes until its pull has passed
  that position. The cloud records the barrier, and the client enforces it, because only the
  client knows how far it has read.

**As built — the PC side, stage 3 (local migration 093, 2026-10-25, not yet released).**

- **The cache.** Every sync pass reads `current_leases()` after its pull and replaces
  `sync_domain_leases` whole, tied to the project, just as the pull cursor is. A lease from test
  never authorises a write for production. A project without 011 (production today) answers
  "not supported". Carton sync carries on, and the gate lets the PC write as it did before
  leases: such a project can neither enforce a lease nor receive leased work, and a missing
  migration must not be able to lock the store. Work written there is queued unstamped and waits
  for the backfill.
- **The gate** (`leaseWriteDecision` in `@erp/sync`, enforced by `leaseGuard.ts` in the main
  process):
  - A PC not set up for sync writes as before. A synced PC writes only as the holder of the
    domain's lease, once it has read past the barrier with no event of the domain from before it
    still parked.
  - Otherwise it refuses with NO_LEASE_INFO, NOT_HELD, HELD_ELSEWHERE (naming the holder) or
    CATCHING_UP.
  - It reads the cache, so the holder writes offline.
- **Which writes are leased** is one list, `leaseChannels.ts`. Milestone 1 enforces the raw material
  store and master data only. A write that rewrites stock history (an item import, a removal, a
  unit correction) needs both. A test fails on any channel in those modules that is unclassified.
  Carton flows, products, and removal or correction *requests* are listed as unleased, each with
  its reason.
- **The epoch is stamped as the event is queued,** in the same insert, from the cached lease
  (`enqueueSyncEvent`). A leased row queued without one (made before the PC knew its lease, or
  while standalone) is **never claimed or counted as sendable**. It waits for the backfill, so
  it's never refused into the dead letters.
- **Label runs and packets are now pushed** through 012 with their epoch, the run before its
  packets. RUN_NOT_REGISTERED_YET waits, and NOT_LEASE_HOLDER is a bounded refusal.
- **Rollout rule:** grant the leases before the release reaches a synced PC (docs/36 §7.8).
- **Stage 3b, the screens (2026-10-25):** the renderer reads `getWriteLeases` (re-read every
  30 seconds) and, on a reader:
  - Raw Material Input and Output become a **packet lookup**: the same toolbar and way back, the
    reason in words, and a scan box that reads the packet's journey and changes nothing.
  - Hand moves are replaced by the notice. A program opened in Machine Store Out is shown with
    the panel's existing view-only mode.
  - The Raw Material sections (Stock and Labels for the store, Stock and Setup for master data),
    parties and machines show a read-only notice.
  - While the status is still being read, a station waits, so a reader never sees it for a
    moment. If the status can't be read, nothing is hidden, because the main-process gate decides
    regardless.
  - A refused write's message reaches the operator without Electron's "Error invoking remote
    method" wrapping (`withoutIpcPrefix`, applied to every toast).
- **Deferred: a release button.** A release has to run inside a sync pass, under the pass's
  single-flight guard, after the push, with nothing of the domain left unsent. Until it's built,
  a handover is the owner's grant (docs/36 §7.8). The old holder syncs until its queue is empty,
  then the new holder is granted, and the takeover records the same barrier: the old holder's
  last write. Edit buttons on the master-data screens are not yet disabled on a reader. The
  notice explains, and the gate refuses the write itself.
- **Proven live, 2026-10-25,** on test, with two dev instances (`dev-gate-holder`,
  `dev-gate-reader`, data folders `C:\erp-gate-*`):
  - With no grant, both were read-only.
  - After the grant, the holder could write, and the reader was locked, naming the holder.
  - A 10-label run reached the cloud 2.7 s after it was made. It was sent by a save (trigger
    `SAVE`), stamped with epoch 1, and accepted first time.
  - The reader applied the run and all ten packets with `replicated_at` set and nothing parked,
    and its packet lookup showed them.
  - The test found screens swallowing refused writes, fixed centrally (`desktopApi()` reports
    every lease refusal).

**As built — stage 4a, capturing master-data changes (local migration 094, 2026-10-25).**
Owner decision, 2026-10-25: the database marks what changed (triggers), rather than each write
path remembering, for the same reason the refused-write fix had to be central.

- **One map, `MASTER_CAPTURE` (`masterCapture.ts`):** 14 master tables, each mapped to one of the
  eight records. Children mark their parent: a material's values and unit steps mark the
  material, a category's fields and options mark the category, a unit's conversions mark the unit,
  and a preset's steps mark the preset. Every insert, update and delete marks the record in
  `sync_dirty_records`, in the same transaction as the write, with the master-data lease epoch held
  at that moment.
- **Bulk operations:** a mark is one row per record. Importing 400 materials (item, value and unit
  step rows) is 400 marks, not 1,200 rows. Fifty edits to one material before the next pass are
  one mark. The builder sends one revision per changed record, which is right and well within a
  pass's batches.
- **Migrations:** the triggers are generated from the map, not written in a migration, because the
  runner splits on semicolons and a trigger body needs them.
  - They're dropped at the start of every migration run, inside its one transaction, so no
    migration fires them or trips over one naming a table it is rebuilding.
  - They're installed again at the end of every start, which also repairs a rebuild migration that
    dropped a table's triggers with the table.
  - Proven by a test that runs a bulk `UPDATE` and a table rebuild as a migration: nothing is
    marked, and all three triggers are back.
- **Receiving and the backfill:** `withCaptureSuppressed` turns marking off for writes that aren't
  this computer's own changes. It runs inside those writes' transaction and refuses to run
  outside one, so a crash rolls the switch back and it can never be left off.
- **Coverage test:** every table in a fully migrated database is either in `MASTER_CAPTURE` or
  listed as not master data, with a reason. That list covers 91 tables in 11 groups: carton flows,
  products (not in Milestone 1), store events, documents, approvals, people, workspace, and
  per-computer state. A new table in neither list fails the suite, and so does a master table
  missing any of its three triggers. The cloud schema test checks that the eight records match
  013's seeds exactly.
- **Next, stage 4b:**
  - the builder: snapshot each marked record whole, give it its next revision, and queue it, with
    the local outbox widened for the eight types;
  - the transport through `push_leased_record`;
  - the receiving contracts: whole-record replace with capture suppressed, parking for a missing
    record a revision refers to, a refusal for a name clash, and a deletion that waits while
    something still uses the record.

**Pull interval: 60 seconds (owner decision, 2026-10-25).** Realtime wake-up is deferred until the
stock slice is delivered and in use. An idle pass is three small requests, about 10 MB a day per
PC. Passes that did nothing aren't logged, and `sync_runs` keeps idle passes for a day and the rest
for 30 days. The latest success is always kept.

### The stock-screen slice — the minimum for raw-material stock on another PC (owner, 2026-10-25)

The goal is the owner's boss seeing correct raw-material stock on his own PC. The order is:

1. **4b: master data travels**, all eight records. A material needs its category and units, a
   stock event can name a party, and a material can name its work section. Builder, transport,
   receiving contracts.
2. **Stock events travel**, as a new leased event type `STOCK_EVENT`:
   - cloud mirror, leased push and log (migration 015; 014 became the sync-health report);
   - local capture by a trigger on `inventory_stock_events`, so every write path is covered;
   - a receiving contract that stores the event and moves the balance.
   **The event carries `balanceDelta`**: `inventory_stock_events` holds two sign conventions,
   including `TRANSFER_OUT` with both signs. `stockEventBalanceDelta` (domain) reads both
   correctly. On the snapshot it reproduces all 903 balances, where a plain sum gets 148 wrong.
   The receiver applies the delta and never re-derives a sign.
3. **Backfill:** the holder sends its existing master records and stock history once, with
   capture suppressed, under its current epoch. A new PC is then provisioned from the cloud,
   **not** from a copy of the store PC's database. A copy would carry vouchers and ledgers that
   then go stale on that PC.
4. **Ledger guard:** parties replicate in step 1, so party balances must be hidden on a PC that
   doesn't hold the vouchers (docs/38 §3). This ships with the slice.
5. **A record that waits is never silent (owner decision, 2026-10-25), built before the slice goes
   live.** A parked revision still waits indefinitely, because dropping it would lose it. But:
   - **Age tiers:** under an hour is normal. Over an hour is stuck, a warning. Over a day is
     stale, which stays up until it's dismissed.
   - **In words:** each parked row names what is waiting and what it waits for.
   - **On the stock screen, row by row:** every material whose record or stock is incomplete
     carries its own mark, so someone checking one material knows whether *that row* can be
     trusted. A banner alone isn't enough.
   - **Reported to the cloud:** each heartbeat carries the stuck count and the oldest age, so one
     query shows which PCs are stuck, since when and on what. Nobody opens a Health page on a
     reader.
   - **Fixable at the source:** the holder sees its unsent and unstamped marks and dead letters,
     and can send a record again. The builder sends prerequisites first.
   - **Superseded waiters remove themselves** once a newer revision has applied.
6. **Live test,** with a third, **empty** instance as the boss's PC. It must reach the same stock
   as the holder from the cloud alone.

**Not in the slice, and what that means:**
- **Packet movements (`raw_material_qr_events`) don't travel yet.** Stock numbers are right, but a
  packet lookup on the boss's PC shows a packet as generated even after it's received or issued.
- **The W.5 history rewrites aren't replicated yet:** unit correction, item removal and run
  erase. Each would leave the boss's PC disagreeing until it's handled. They're rare operations,
  and they're the next work after the slice.
- **Dana issues follow W.6, as decided.** The reader applies the event without the machine-program
  link, which it can't hold yet, keeps the program id alongside the event, and restores the link
  when programs replicate.

**As built — waiting visibility (item 5), 2026-10-25/26.** Cloud migration 014 is written and
not yet applied to test.

- **Tiers and words** (`packages/sync/src/waiting.ts`): every parked event and every displaced
  record is an entry. Each says what waits (named from its own body), what it waits for, since
  when, its tier, and the material it leaves incomplete.
- **Name swaps don't deadlock** (local migration 096): when a revision needs a name that an
  out-of-date record here still holds, that record is renamed `~moved:<id>` and recorded in
  `sync_displaced_records` with the name it had. It shows as incomplete until its own revision
  arrives. Bounded at three per apply.
- **Stock screen:** every row whose material waits carries a mark in words. Under an hour it
  reads "Still arriving", after that "Incomplete here", and the cause is read out to screen
  readers too. Above the table, a notice appears once a wait has lasted over an hour, and the
  materials not on this PC at all are listed by name.
- **App-wide notice:** over an hour is a warning, over a day an error. A dismissal holds only for
  the waits it was shown for; a new wait, or a worse tier, brings it back.
- **Cloud report** (`device_sync_health`, 014): **one row per PC, overwritten, never appended.**
  A report is sent when it changes or every 15 minutes, so about 96 calls a day. It carries
  counts, the oldest age, up to five waits in words (each with `needs`, the record that would
  end it), dead letters, and unsent marks. Readable by the factory's enrolled PCs; written only
  through `report_sync_health` under the PC's own claim.
- **Fixable at the source:** the Health page shows "Waiting on this computer" and, for
  administrators, "Other computers". **Send Again** next to a wait marks that record under the
  lease held now, and the next pass sends a new revision. It is a leased MASTER_DATA write, so
  only the holder can do it, and it is refused when the holder doesn't have the record. Unsent
  marks (changes made before this PC synced) are counted but left for the backfill: restamping
  them with today's epoch could overwrite a change another holder made in between.

**As built — leased records, cloud migration 013 (applied to test and verified 2026-10-25, docs/36 §6a.2).**

- **One generic store, not a mirror per table.** `leased_records` holds one row per (type, id):
  the holder's whole record as JSON, its revision, and whether it is deleted. A document is one
  record: an item with its values and unit steps, a category with its fields and options, a
  ladder preset with its steps. It replaces as one, never row by row.
- **The cloud judges the envelope, and the receiving PC judges the body.** The cloud checks that
  the type is known, that the pushing PC holds that type's lease under the record's epoch, and
  that the revision moves forward. The body is validated by the receiver against its own schema,
  like every other payload. A typed cloud mirror would have to change with every local migration
  that touches master data, without adding a check the receiver doesn't already make.
- **Revisions:** newer → UPDATED (INSERTED the first time). The same revision and content →
  DUPLICATE. The same revision with different content → REVISION_CONFLICT, refused and visible.
  An older revision → SUPERSEDED, acknowledged but not applied, because applying it would roll the
  record back. A deletion is a revision with no body.
- **Every revision is its own log event** (`TYPE:id:revision`), so a reader that missed one
  converges on the next.
- **Milestone 1 types**, all under MASTER_DATA: `PARTY_GROUP`, `PARTY`, `INVENTORY_UNIT`,
  `UNIT_LADDER_PRESET`, `INVENTORY_CATEGORY`, `INVENTORY_ITEM`, `WORK_SECTION`, `MACHINE`.
  Milestone 2's documents and approvals are leased records too: each one is a row in
  `leased_record_types` naming its domain, not a new migration of this shape.
- **DECIDED — owner, 2026-10-25: money in master data replicates.**
  `inventory_items.cost_price_paisa` and `parties.balance_limit_paisa` travel inside their
  records like every other column. **A leased record replicates whole.** If a field is held back,
  the other PCs hold incomplete records. When the lease moves to one of those PCs, it edits and
  writes back records that are missing data it never received, and that silently deletes the
  data everywhere.
  **Hiding cost prices from operators is a screen permission, not a replication decision.** If
  it's wanted, it is built as a permission on the screens that show prices, and the record stays
  whole underneath.
  (Migration 008's product variants carry no price for a different reason: that contract is an
  identity-only, insert-only record, not a whole leased record.)

### W.3 Handover — the one place this model can lose work

| Path | Rule |
|---|---|
| **Release** (normal) | The holder drains its outbox for that domain, then releases. The release records the log position of the holder's last write. |
| **Catch-up barrier** | The new holder may not write until it has pulled up to that position. Otherwise it would edit a stale copy of a document. |
| **Forced takeover** (holder lost, or offline for good) | An owner action. The old holder's unpushed writes for that domain are refused at push and parked as visible dead letters, never silently dropped and never merged. |

### W.4 What stays multi-writer, and the risk that comes with it

Identity dedupe makes **registering** a carton or packet safe from any PC. It does not stop two
PCs **acting on reservation state** in the same offline window:

- **FIFO store move-out (§1a item 1) remains.** A plain Store Move Out scan is a carton flow
  (multi-writer), but it auto-reconciles to the oldest open gatepass line, and gatepass lines
  are in the Sales & dispatch domain. Two PCs scanning offline can still consume one reservation
  twice. **Proposed rule, needs a business decision:** only the Sales & dispatch lease holder
  auto-reconciles. Any other PC records the move-out unreconciled, and the holder reconciles it
  on arrival.

### W.5 Raw-material history that is rewritten — found 2026-10-23

Class A assumes rows are never edited or deleted. Three raw-material operations do exactly that
today. Each is a legitimate business correction, and each would leave readers silently wrong if
only inserts replicated:

| Operation | Where | What it rewrites | What a reader would show |
|---|---|---|---|
| **Erase a label run** (untouched runs only) | `deleteRawMaterialQrBatch` | Deletes the run and its packets, and **rewinds the serial counter**, so the same packet ids are printed again | The old packets, then a refused re-print (the identity-conflict guard catches it, but the reader is stuck) |
| **Correct a material's unit** (no labels printed yet) | `rawMaterials.ts`, the unit-correction path | `UPDATE inventory_stock_events SET unit_id` for **every past movement** of the item | Stock computed in the old unit |
| **Erase a material with its ledger** (approved removal request) | `eraseInventoryItemWithLedger` | **Deletes** the item's stock events and correction requests, and detaches its audit rows | A ghost material still holding stock |

**Under single-writer, each replicates as an explicit correction event that readers re-apply.**
This is safe only because the store and master data have one writer: no reader can have scanned
the erased run, moved stock in the old unit, or touched the erased item. With concurrent writers
none of the three would be safe to replicate. The cost is one contract per operation, applied in
log order after the rows it corrects. Counted in §3.1.

### W.6 Raw-material events that point at machine programs

`raw_material_qr_events` (three machine-program columns) and `inventory_stock_events`
(`machine_program_id`, Dana issues) link store-out movements to the program they were issued for.
With raw material replicating **before** machine programs, a reader has the movement but not the
program. If the event waits for the program, the reader's stock stays **overstated** until machine
programs replicate, by every issue made to a program. That is confidently wrong stock, the outcome
this plan exists to prevent.

**DECIDED — owner, confirmed 2026-10-25.** A reader applies the movement **without** the
machine-program link, keeping the origin's program ids in the event's metadata, so stock moves
correctly at once. When machine programs replicate, the link is restored from the metadata. Only
the holder can issue against a program, and the holder has the programs locally, so nothing is
lost at the origin. **Not to be raised again**: the stage-5 contracts for `raw_material_qr_events`
and `inventory_stock_events` are built this way.

---

## U. People and machines — APPROVED 2026-10-23, scheduled after Milestone 1

Two designs, both approved by the owner on 2026-10-23, and both built **after** the raw-material
milestone, not before. The owner's words: *"I'd rather have the store replicating in 11–14 weeks
than conveniences in 5."* Their order relative to Milestone 2 is not yet decided.

### U.1 In-app machine enrolment — replaces the dashboard work

**The gate moves into the app. It is not open signup.**

1. **A new PC asks to join.** It signs in to the project **anonymously** (Supabase anonymous
   sign-in), files a join request through a database function, and shows a 6-digit pairing code.
   The request carries the PC's **existing** `deviceId` and `workstationId`; nothing is minted.
   Requests expire after ~30 minutes, with one pending per PC and a cap on the total.
2. **An admin approves inside the ERP** (Settings → Computers): checks the pairing code against
   the new PC's screen, names the PC and assigns its document-number block. Approval is one
   database function. It re-checks the code and the approver, creates the `workstations` and
   `device_accounts` rows, and records who approved it and when.
3. **The new PC picks up the approval** and stores its credential encrypted, as today.
   `ERP_DEVICE_EMAIL` and `ERP_DEVICE_PASSWORD` are retired.
4. **Revocation is on the same screen.** The claim mechanism (migration 006) refuses the revoked
   PC's next upload.

**Why it is safe.** An anonymous account can authenticate and still read and write nothing,
because every policy requires `is_enrolled_device()`. That is already true of a dashboard-made
account before enrolment. **No `service_role` key anywhere, and no edge function:** only database
functions with fixed privileges, the pattern the claim and push functions already use.

**What stays manual, once per project:** switching on anonymous sign-ins, pasting the migration
(it contains `revoke`, which the MCP tools refuse), and enrolling the very first PC.

**Approver identity.** Until U.2 exists, the cloud knows machines, not people, so approval means
"an approver PC says its local admin approved". Only PC 1 is an approver PC. U.2 upgrades this to
a real admin, verified by the cloud.

**Until it is built:** enrolment stays as `docs/36 §7.6` B — the auth user created in the
dashboard, and the `workstations` and `device_accounts` rows written through MCP from the identity
read off the PC.

### U.2 Cloud-authoritative logins with per-PC caching — replaces "logins stay local"

This **supersedes the 2026-10-22 decision** that each PC keeps its own accounts (`docs/38 §2`).
The decision's two reasons still hold, and the design keeps both:

- **No password hash or verifier ever replicates.** Kept from the original decision, and
  binding. `app_users` stays on the exclusion list (`replicationScope.ts`).
- **No last-write-wins on accounts.** Every change to an account is made by a cloud function and
  arrives on every PC in log order, as a new credential version.

**Cloud:**

- A people table holding a bcrypt verifier that no client can read (pgcrypto has no PBKDF2).
- `verify_login`, callable only by enrolled PCs, with a per-person failed-attempt lockout. A
  success returns a short-lived person token bound to that PC. Admin functions require it, which is
  how U.1 gets a real approver.
- **Online-only** functions for creating people, resetting passwords, revoking, and assigning
  roles and permissions. User administration needs the internet. That is accepted: it is rare.

**What replicates to every PC — non-secret only:** username, display name, status, roles,
permissions, and a **credential version** that changes on every password change or revocation.

**What each PC keeps:** a cached verifier only for people who have logged in **on that PC**,
computed locally with a fresh salt at the moment of a successful online login.

**Login rules:**

| Situation | Rule |
|---|---|
| Cloud reachable | Verified by the cloud, every time. The cache is refreshed. **A cloud refusal is final:** never fall back to the cache after a "no". |
| Cloud unreachable | The cache is accepted only if its credential version matches the latest this PC has synced, **and** it was last confirmed online within **7 days** (owner, 2026-10-23). |
| On every sync | Cache entries whose version is stale, or whose person is revoked, are wiped. |
| First login on a PC | **Needs the internet.** That PC has never seen the person, and pre-loading a verifier would be distributing hashes. Mitigations: the PC where an admin creates someone caches them at once, and the admin screen shows which PCs each person is ready on. |

**The window that remains, stated plainly:** a PC offline since before a revocation still accepts
that person until it syncs, or for at most 7 days. Any login that works offline has a window like
this; the maximum age is what bounds it.

**Existing accounts move without resets:** on each user's next online login on PC 1, the password
is checked locally (PBKDF2), then sent once to set up the cloud verifier.

### U.3 Effort

| | Effort |
|---|---|
| U.1 in-app enrolment | **1.5–2 wk** |
| U.2 cloud-authoritative logins | **3–4 wk** |

Added to the plan in §3.1.

---

## 1. Part one — contracts, by replication class

Four classes. The class decides the conflict rule; the domain does not.

### Class A — Append-only events: conflict-free by construction

Insert-only, immutable, deduplicated by id. Two PCs cannot conflict because neither ever
modifies a row. **This is where ~80% of the data lives, and it is the easy 80%.**

| Table | Rows | Notes |
|---|---|---|
| `inventory_stock_events` | 5,977 | RM stock movements. The authority for RM stock. |
| `raw_material_qr_events` | 5,609 | Packet lifecycle (move in / move out / return). |
| `production_events` | 819 | **Contract already exists** (`PRODUCTION_PRODUCED`). |
| `inventory_item_audit` | 1,119 | |
| `audit_log` | 148 | |
| `raw_material_qr_batches` | 1,048 | Label run records. |
| `qr_codes` / `qr_batches` | 783 / 103 | Carton registry. Insert-only; `qr_codes.status` is the exception — see below. |
| `machine_program_*_carton_labels` | 87 | Label records. |

**Conflict rule: none needed.** Dedupe on primary key, `on conflict do nothing`.

**The one trap in this class:** `raw_material_qrs` (4,659 rows) *looks* like registry but carries
`updated_at` and a mutable status. It must be split exactly as `qr_master` already is — the
**identity** replicates insert-only, and the **status is derived locally** from
`raw_material_qr_events`. Shipping a packet's status as a value would make the last writer win
and silently misstate what is in the store. The same applies to `qr_codes.status`.

That rule is already written down in `packages/sync/src/contract.ts` for dispatch and returns:
*"mutable state that has to be derived from the events on each computer, never shipped as a
value."* It generalises to every domain here.

### Class B — Derived projections: never replicated, always recomputed

| Table | Rows | Recomputed from |
|---|---|---|
| `inventory_stock_balances` | 903 | `inventory_stock_events` |
| `stock_projection_by_variant` | 30 | `production_events` + store/dispatch events |
| `stock_projection_by_location` | 58 | same |
| `report_daily_summary` | 0 | events |
| Party ledger balances | *not stored* | `sale_vouchers` + `cash_vouchers` + `purchase_vouchers` + `sale_returns` |
| Gatepass "Reflected" stock | *not stored* | Current − Reserved |

**Conflict rule: not applicable — these are never sent.** This is the single biggest reason the
project is tractable: **no balance and no stock figure is stored as a shippable value anywhere.**
Ledgers are computed, stock is a counter over events. Nothing here needs delta merging.

**Work required:** a projection rebuild that runs after a pull applies events, and is correct
regardless of the order events arrive in. `applyEnvelope` deliberately does not touch stock today
("Counting arrivals while dispatch, returns and store movements stay local would make the
receiving computer's stock confidently wrong") — under full replication that restriction lifts,
and the rebuild becomes mandatory rather than forbidden.

### Class C — Per-PC local state: never replicated

See §0.2. `sync_outbox` (868), `app_settings` (13), `qr_sequences` (35),
`raw_material_qr_sequences` (743), `user_sessions` (3), `system_health_snapshots` (372),
`backup_history` (16), `schema_migrations` (84), `devices` (1), own `workstations` row,
`metrics_counters`, `metrics_timeseries`.

### Class D — Mutable shared records: the actual work

> **Superseded by §W (2026-10-23).** Every Class D table belongs to a leased domain, so it has one
> writer. The conflict rules below (last-write-wins, divergence refusal, transitions-as-events)
> were designed for concurrent writers and are **not being built**. What replaces them is simpler:
> the holder's revision of a record or whole document replaces the receiver's copy, and a revision
> from a PC that does not hold the lease is refused in the cloud. The analysis is kept because it
> is the argument for the lease. Revisit it if a domain is ever opened to more than one writer.
>
> D4 is replaced by §U.2 (approved 2026-10-23): accounts become cloud-authoritative, with
> non-secret facts replicated and per-PC verifier caches. Password hashes still never replicate.

#### D1 — Master data: last-write-wins on `updated_at` is proportionate

| Tables | Rows |
|---|---|
| `parties`, `party_groups` | 18, 10 |
| `article_sizes`, `product_variants`, `article_series`, `main_groups`, `product_groups`, `product_sub_groups`, `product_types`, `sole_types` | 35 + 15 + small |
| `inventory_categories`, `inventory_category_fields`, `inventory_category_field_options`, `inventory_units`, `unit_ladder_presets(+steps)` | 52, 75, 403, 13, 15 |
| `machines`, `work_sections` | 3, 1 |
| `roles`, `role_permissions`, `job_role_options` | 8, 31, 2 |

**Conflict rule: LWW on `updated_at`, with soft delete and an audit row recording the overwrite.**

Defensible because these are edited rarely, by one person at a time, and a lost edit is *visible
and retypeable* — a party's phone number reverting is noticed and fixed in seconds. That is not
true of a document.

**Caveat:** `updated_at` is a wall-clock from the writing PC. Two PCs with skewed clocks resolve
LWW wrongly. Mitigation: compare `(updated_at, origin_device_id)` so ties and near-ties are at
least deterministic, and keep an overwrite audit so a surprising revert is explicable.

#### D2 — Documents: LWW loses data, and must not be used

| Document | Header rows | Child rows |
|---|---|---|
| Gatepass | `gatepasses` 2 | `gatepass_lines` 2 |
| Sale voucher (bill) | `sale_vouchers` 2 | `sale_voucher_line_items` 2 |
| Cash voucher | 0 | `cash_voucher_lines` 0 |
| Purchase voucher | 0 | `purchase_voucher_line_items` 0 |
| Machine program | `machine_programs` 5 | `runs` 14, `upper_lines` 27, `article_rates` 8, `closures` 2, `issue_batches` 84 |
| RM item | `inventory_items` 940 | `inventory_item_values` 2,707 |
| Sessions | `raw_material_receiving_sessions` 165, `raw_material_issue_sessions` 109, `store_*_sessions` 10, `dispatch_sessions` 2 | — |

**Conflict rule: document-level versioning, whole-document replace, and a refusal on divergence.**

Not row LWW. A gatepass is a header plus N lines; row-level LWW can let PC A's header win while
PC B's lines win, producing a document that neither operator wrote and that may violate its own
totals. The unit of conflict must be **the document**, with a monotonic revision per document and
a rule that a concurrent edit is **refused and surfaced**, not merged.

**Note the volumes.** Every document type except RM items has fewer than 200 rows, and the two
hardest (gatepass, bill) have **two rows each**. The hard conflict work protects almost no data
today — which is an argument about sequencing, not about skipping it.

#### D3 — Approval workflows: the transition must become an event

`stock_correction_requests` (40), `removal_requests` (12), `access_requests` (2),
`party_claims` (0), `permission_requests` (0).

**Conflict rule: model the approval as an append-only transition, not a status field.** A status
column under LWW lets "approved on PC 1" and "rejected on PC 2" resolve by timestamp — a business
decision settled by a clock. As events, both transitions are recorded and the first one wins
deterministically, with the second visible as a refused duplicate.

#### D4 — Users and permissions: a security decision, not just a conflict rule

`app_users` (3, holds password hashes and salts), `user_role_assignments` (2),
`user_additional_permissions` (4), `user_notifications` (89).

**Conflict rule: LWW is not acceptable here.** Two specific problems:

- **Replicating password hashes** puts every user's credential material on every PC, including a
  stolen one. The local DB is not encrypted (see `docs/36 §4b`).
- **A user disabled on PC 1 must be disabled everywhere, immediately.** Under LWW with a clock
  skew, a revocation can be overwritten by a stale edit from another PC — a revoked account
  coming back to life.

Recommend: replicate *identity and role assignment*, keep credential material local, and model
enable/disable as a transition (D3) so a revocation can never be overwritten by an older edit.
This needs an explicit owner decision before it is built.

---

## 1a. Where two PCs editing offline genuinely lose data

Seven, in descending order of how badly they fail.

> **Status under the single-writer model (§W):**
>
> | Item | Status |
> |---|---|
> | 1. FIFO reservations | **Still open.** Carton move-out stays multi-writer. See §W.4 for the proposed rule, which needs a business decision. |
> | 2. Gatepass ↔ bill lock | **Solved by construction.** Both are in one domain, with one writer. |
> | 3. Multi-row documents | **Solved.** One writer; the whole document is replaced by revision. |
> | 4. Child ordinals | **Solved.** One writer per parent. |
> | 5. Machine program identity | **Solved.** One writer for the domain. |
> | 6. `inventory_items` EAV | **Solved.** Master data has one writer. |
> | 7. Users and permissions | **Designed in §U.2** (approved 2026-10-23). Every account change is a cloud function, arriving on every PC in log order, so no last-write-wins. |

1. **Gatepass reservations and FIFO store move-out — the hardest problem here.**
   `Reflected = Current − Reserved`, and a plain Store Move Out scan is auto-reconciled to the
   **oldest open gatepass line** (FIFO, stamped on `production_events.gatepass_id`). Two PCs
   scanning offline each pick the same oldest open line, and **one reservation is consumed
   twice**. This is not a lost edit — it is a wrong stock figure that reconciles against nothing,
   and no row-level conflict rule detects it. Needs either a reservation claim in the cloud (which
   breaks offline operation) or a reconciliation pass that detects and repairs double-consumption
   after the fact. **Needs a business decision: which PC's scan wins, and what the operator is
   told.**

2. **Gatepass ↔ bill lock.** `docs/23`: bills come only from gatepasses, and **bill quantities are
   LOCKED to the gatepass**. Edit the gatepass on PC 1 and the bill on PC 2 and the invariant
   breaks with no row-level conflict anywhere — each document is individually consistent and
   jointly wrong. Needs the gatepass and its bill to be one conflict unit.

3. **Multi-row documents** (all of D2). Header and lines resolving independently produces
   documents nobody wrote. Mitigated by document-level versioning; listed separately because it
   applies to every document type at once.

4. **Child ordinals.** `machine_program_runs.run_no`, `machine_program_upper_lines.line_no` and
   `inventory_category_fields.sort_order` are all allocated `MAX(...)+1` **per parent**. Two PCs
   adding a run to the same program offline both allocate the same `run_no`. Needs either per-PC
   ordinal partitioning or an ordering key that is not a dense integer.

5. **Machine program identity.** One program per machine per day is the key. Two PCs opening a
   program for the same machine and date offline create two programs that must become one.
   Merging them means merging their runs and reservations.

6. **`inventory_items` + `inventory_item_values`** (940 + 2,707). An EAV model and the largest
   mutable set by far. A value edited on PC 1 while the item is re-categorised on PC 2 can leave
   values attached to fields the new category does not have.

7. **Users and permissions** (D4). A revocation overwritten by a stale edit.

---

## 2. Part two — the one-time backfill

### 2.1 The 868 legacy outbox rows

Measured: **867 `PRODUCTION_EVENT`** (the pre-082 catch-all type) and **1 `DISPATCH_EVENT`**,
created 2026-10-06 → 10-13. Migration 082, which introduced `PRODUCTION_PRODUCED`, was applied
2026-10-15. **No production has happened on this machine since.**

**They are a dead queue, not a source of truth.** The authoritative data is the 819
`production_events` and 477 `qr_master` rows they refer to. So:

- **Do not rewrite them in place.** The old type name and payload shape do not match the current
  contracts, and patching a queue row is guessing at what a scan meant.
- **Re-derive instead.** Walk `qr_master` and `production_events` and enqueue fresh `QR_MASTER`
  and `PRODUCTION_PRODUCED` rows. Idempotent: `dedupe_key` is `QR_MASTER:{qr_id}` and
  `PRODUCTION_PRODUCED:{event_id}`, so re-running is a no-op.
- **Then retire the 868** — mark them `SYNCED` with a note, or delete them, once the re-derived
  rows have been acknowledged. Deleting a queue row destroys no business data; the events remain
  in `production_events`.

### 2.2 Getting ~27,000 rows up, and down to a new PC

Two directions, and the second should **not** be done by replaying events.

**Up (host → cloud).** Walk the authoritative tables in dependency order — master data, then
registries, then events — pushing in idempotent batches. Volume is small; the work is the
ordering and the idempotency, not the throughput.

**Down (cloud → new PC): snapshot plus log tail, not a 27,000-event replay.**

Replaying every event through a per-row applier is slow, and every row is a chance for a refusal
that strands a new PC halfway. Instead:

1. Restore a **database snapshot** on the new PC — the application already has verified backup
   and restore (`createBackup` / `restoreBackup`, and `docs/36 §6`).
2. **Scrub the Class C tables** from the restored copy (§0.2). This is mandatory: a snapshot that
   keeps `app_settings` hands the new PC **block 1**, and one that keeps `qr_sequences` hands it
   another PC's serial counters.
3. **Re-mint the device identity.** A copied data folder copies `device-identity.json`, and both
   machines then claim the same workstation (`docs/35 §6`). `device-credential.bin` will not
   decrypt on the new machine — which is deliberate — so the new PC must re-enrol.
4. **Set the pull cursor** to the snapshot's high-water mark and let the normal pull carry the
   tail.

This reuses machinery that exists and is tested, and it turns a 27,000-row risk into a file copy
plus a short catch-up.

---

## 3. Rough effort

### 3.1 Re-estimate: single writer, raw material first (2026-10-23)

Dev-weeks of **remaining** work. Already done, and not counted: §0.1 numbering, §0.2 exclusion
list, the general applier with `replicated_at` and the identity-conflict guard, and the receiving
side of the RM label-run contracts.

**Milestone 1 — raw material end to end**

| Part | Scope | Effort |
|---|---|---|
| **Prerequisites, remaining** | **Parking:** a waiting event is held locally so the pull cursor moves past it. Today one waiting event stalls the cursor, and once 200 events queue behind it, nothing newer is fetched. Also: opening `sync_outbox.aggregate_type`, generalising the cloud `sync_event_log` beyond two types, and keying the pull cursor by project (`docs/36 §7.7`) | **1.5–2 wk** |
| **Write lease (§W)**, two domains | Cloud lease and RPCs on the 006 claim pattern, the lease check inside the store and master-data push RPCs, the local gate on store and master-data write paths, read-only store and material screens, and release, catch-up and forced takeover | **2–3 wk** |
| **Master data under lease** | `inventory_items` + values (EAV), categories, fields, options, units, ladders, item unit steps, parties and groups, work sections, machines: whole-record replacement by revision | **2–2.5 wk** |
| **RM Class A** | Stock events, packet events, receiving and issue sessions, the label-run sender side, and cloud tables, push RPCs and log triggers for each | **1.5–2 wk** |
| **§W.5 corrections** | Run erase, unit correction and item erase as replicated correction events | **1 wk** |
| **RM Class B** | Balances and packet status rebuilt from events. **The rebuild must call the same balance calculation the live write uses**, which means extracting it from `applyRawMaterialStockChange` first, not writing a second one. | **1 wk** |
| **§W.6 machine-program links** | Apply without the link, keep the ids in metadata, restore later | **0.5 wk** |
| **RM backfill + ledger guard** | Push the existing raw-material history and master data to production, provision readers by snapshot (§2.2), and hide party ledger balances on PCs that do not hold vouchers (`docs/38 §3`), because parties now replicate months before vouchers do | **1.5–2 wk** |
| | **Milestone 1** | **~11–14 wk** |

**Milestone 2 — everything else**

| Part | Effort |
|---|---|
| Carton Class A (`qr_codes`, `qr_batches`, the other production event types, carton labels) and carton Class B | **1–1.5 wk** |
| The lease's read-only gating for the remaining domains | **0.5–1 wk** |
| Documents and approvals under lease | **1–1.5 wk** |
| §W.4 FIFO, after a business decision | **0.5–1 wk** |
| Backfill for the remaining domains | **0.5–1 wk** |
| **Milestone 2** | **~3.5–6 wk** |

**People and machines (§U), after Milestone 1:** U.1 in-app enrolment **1.5–2 wk**, U.2
cloud-authoritative logins **3–4 wk**, so **~4.5–6 wk**. Order relative to Milestone 2 is not yet
decided.

**Total remaining: ~19–26 weeks with §U.** Without §U it is ~14.5–20 weeks, against 12–16.5 for
the carton-first order. About 1–1.5
weeks of that is the reorder itself: the §W.6 interim, and building the lease gating and backfill
in two passes. About 1 week is the §W.5 finding, which any order would have hit.

**The store does not wait for this.** It already runs end to end on one PC today: receive,
issue, labels, Dana, stock. Milestone 1 gives **other** PCs an accurate read-only view of it. It
is not what makes the store usable.

### 3.2 Original estimate (2026-10-22), before the write model

Dev-weeks, assuming the business decisions in §1a are already made. They are not yet.

| Part | Scope | Effort |
|---|---|---|
| **Prerequisites** | §0.1 origin columns (14 tables) + `countOutsideRange` rewrite + its tests; §0.2 exclusion list; general applier; projection rebuild; open `sync_outbox.aggregate_type`; generalise the cloud `sync_event_log` beyond its two triggers | **3–4 wk** |
| Class A | Append-only events and registries (~20k rows, 8 table groups) | **1.5–2 wk** |
| Class B | Projection rebuild correctness, order-independence | **1 wk** |
| Class D1 | Master data LWW + overwrite audit + clock-skew tie-break | **1–1.5 wk** |
| Class D2 | Document versioning, whole-document replace, divergence surfaced in the UI | **3–4 wk** |
| §1a items 1–2 | Gatepass reservations / FIFO double-consumption, and the gatepass↔bill lock | **2–3 wk**, *after* a business decision |
| Class D3 + D4 | Approval transitions; users and permissions | **1–2 wk** + a security decision |
| **Part 2** | Backfill: re-derive, retire the 868, snapshot + scrub + cursor, idempotent up-push | **2–3 wk** |
| | **Total** | **~15–21 wk** |

That is **four to five months of focused work**, and it is a different project from the carton
pilot rather than an extension of it. Stated plainly because the estimate is the most useful part
of this document.

---

## 4. Recommended sequencing

> **Current order (2026-10-23): full scope, single writer, raw material first.**
>
> *Milestone 1 — raw material end to end:*
>
> 1. **Prerequisites:** parking, outbox types, the cloud log, and the project-keyed cursor.
>    **Parking comes before any raw-material type is switched on for pull.**
> 2. **Write lease** for Raw material store and Master data. It moves **ahead of** the events,
>    because the store is a leased domain: the cloud has to refuse a store push from a non-holder
>    from the first one.
> 3. **Master data under lease**, before the store events that depend on it.
> 4. **RM Class A, the §W.5 corrections and the §W.6 interim.**
> 5. **RM Class B rebuild.**
> 6. **RM backfill and the ledger guard.**
>
> *Milestone 2:* cartons and production (already piloting, so least risk), then documents,
> approvals, FIFO, and the remaining backfill.
>
> *People and machines (§U), approved 2026-10-23, after Milestone 1:* in-app enrolment (U.1), then
> cloud-authoritative logins (U.2). Order relative to Milestone 2 is undecided. Until U.1 lands,
> PCs are enrolled by hand (`docs/36 §7.6`).
>
> Cloud migrations are written and reviewed in the repo, and applied to production only on the
> owner's go-ahead.
>
> The two-PC carton test (step 1 below) is still unrecorded. It remains the cheapest proof that the
> basic path works between two real machines.
>
> The original sequencing follows, unchanged.

**The domains with the most data are the easiest, and the domains with the hardest conflicts have
almost no data.** Gatepasses and bills — the two hardest problems in §1a — have **two rows each**
today. Raw material, which the owner has said matters most, is **~22,000 rows of append-only
events** and needs no conflict rule at all.

So sequence by difficulty, not by volume:

1. **Finish the carton pilot.** Two PCs, one scan, verified in the cloud. Nothing below is worth
   starting until the basic path is proven once.
2. **Prerequisites (§0).** Unavoidable, and nothing else works without them. The numbering fix in
   particular is load-bearing for every later domain.
3. **Class A + B — raw material and stock.** ~22,000 rows, append-only, no conflict rule, and it
   is the domain the owner named as most important. This is where the replication actually starts
   earning its keep.
4. **Class D1 — master data.** Small, low risk, makes the other PCs usable.
5. **Backfill (Part 2).** Once A, B and D1 are contracted, a new PC can be stood up for real.
6. **Class D2 / D3 / D4 and §1a.** The documents. Last, because they hold the least data and need
   the most design — and because by then there will be real two-PC experience to design against.

A defensible stopping point exists after step 5: **raw material, stock, cartons and production
replicate; documents stay local per PC.** That is roughly 7–9 weeks rather than 20, covers ~90% of
the rows and the domain the owner cares most about, and leaves the hardest invariants for when
there is operational experience to design them against. It is not "full replication", and it
should not be described as such — but it may be the better project.
