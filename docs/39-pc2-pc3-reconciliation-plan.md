# 39 — PC2 → PC3 reconciliation plan

Status: **script built and tested, dry run passed on copies (28 Oct 2026). Not yet run for real**
(§10). Nothing has been written to either PC's database. All facts below were read from copies of the
two files (`MESSEDUPDB\erp.local-PC2.sqlite`, `erp.local-PC3.sqlite`, taken with both apps closed on
27 Oct 2026). The originals have only been hashed, never opened. Times are PKT.

Decisions already made by the owner, which this plan assumes:

- **PC3 continues.** PC2 is retired. Its file is kept as evidence and is never used again.
  **Superseded 28 Oct 2026 (owner):** the reconciled database was moved from PC3 to PC2, and **PC2
  is now the store machine. PC3 is retired** and must not record work again. Everything below was
  written before the move and says "PC3" for the computer holding the reconciled database. That
  computer is now PC2.
- The 38 packets that both PCs scanned out left the store **once**. PC3 recorded that correctly at
  19:05 (RMO-000167). PC2's second scan-out of them at 19:30 is **not** brought across.
- PC2's only real contribution is: store-in RMI-000185 (50 packets), 7 new materials, 14 label runs,
  and 29 store-outs of packets only PC2 knows about.
- **All 67 packets PC2 scanned out in RMO-000139 went to Daniyal (PTY-000008).** The storekeeper
  confirmed he picked ASIM SHEHZAD (BHATI) on PC2 by mistake. PC3's record of the 38 already says
  Daniyal, and the 29 brought across are recorded to Daniyal too (§1 step 7).

### Quantities handed to Daniyal on 27 Oct, for the storekeeper to check

| | Packets | DOZEN | Where it is recorded |
|---|---|---|---|
| The 38 (PC2 RMO-000139, 19:30, and PC3 RMO-000167, 19:05) | 38 | **127** | Already on PC3 (RMO-000167). PC3's own figures agree: 127 |
| The 29 (PC2 RMO-000139 only, 19:30–19:33) | 29 | **72** | Brought across to PC3 |
| **Together** | **67** | **199** | |

**The 38, by material:**

| Material | Packets | DOZEN |
|---|---|---|
| RM-000560 SK12 BLACK GREY 7/10 | 3 | 10 |
| RM-000561 SK12 BLACK BLUE 7/10 | 3 | 10 |
| RM-000567 SK12 BLACK NEON 11/13 | 2 | 6 |
| RM-000569 SK12 BLACK BLUE 11/13 | 2 | 12 |
| RM-000604 SK30 BLACK RED 7/10 | 3 | 12 |
| RM-000615 SK30 BLACK RED 11/13 | 1 | 6 |
| RM-000636 SK44 BLACK WHITE 8/10 | 4 | 12 |
| RM-000640 SK46 BLACK RED 11/13 | 2 | 6 |
| RM-000641 SK46 BLACK NEON 11/13 | 3 | 9 |
| RM-000642 SK46 BLACK BLUE 11/13 | 5 | 15 |
| RM-000668 SK44 GREY 8/10 | 4 | 8 |
| RM-000675 SK30 BLACK GREY 1/6 | 5 | 15 |
| RM-000685 SK30 BLACK BLUE 11/13 | 1 | 6 |

**The 29, by material:**

| Material | Packets | DOZEN |
|---|---|---|
| RM-000609 SK30 BLACK WHITE 7/10 | 4 | 8 |
| RM-000637 SK46 BLACK RED 7/10 | 2 | 4 |
| RM-000662 SK46 BLACK NEON 7/10 | 4 | 8 |
| RM-000663 SK46 BLACK RED 1/6 | 3 | 9 |
| RM-000676 SK46 BLACK NEON 1/6 | 4 | 12 |
| SK12 BLACK WHITE 7/10 (PC2's RM-000965, becomes RM-000995) | 5 | 10 |
| SK12 BLACK WHITE 1/6 (PC2's RM-000969, becomes RM-000999) | 7 | 21 |

PC3's RMO-000167 also holds 3 more packets to Daniyal that PC2 never re-scanned: RM_9_606_11, 12
and 13, SK30 BLACK GREY 7/10, 4 DOZEN each. If the storekeeper counts everything Daniyal received
from both sessions that evening, the figure is **67 + 3 = 70 packets, 199 + 12 = 211 DOZEN**.

---

## 0. Do now, before anything else (no software change)

| # | Action | Why |
|---|---|---|
| 0.1 | **Stop using PC2.** No logins, scans or prints. | Every further write on it is one more thing to reconcile. |
| 0.2 | **On PC3, print no labels for supplier _shehzad rubber topping_ (PTY-000006) until this is done.** | PC3's serial counters for this supplier sit exactly where PC2 started printing (§4). Its next run for, say, SK12 BLACK GREY 7/10 would print **RM_6_560_39**, a label already stuck on a packet in the store. Printing for PC3's own RM-000965…971 under this supplier would print **RM_6_965_1** and the like, which are also already on packets (§3). Either way, two physical packets would carry one label. |
| 0.3 | **Put PC2's 21 in-store packets aside** (list in §3.2). Expect PC3 to refuse their labels until then. | PC3 has never heard of these packets. A scan is refused as an unknown label, not taken wrongly, but the packets cannot move until reconciliation. |

---

## 1. What gets re-entered on PC3, in order

Everything goes in **one transaction**, in this order. Each step needs the one before it: a packet
needs its material and its run, a scan needs its packet and its session, and a store-out needs the
store-in.

| Step | What | Rows | Source on PC2 |
|---|---|---|---|
| 1 | **7 materials**, with new codes (§2), their attribute values and creation audit | 7 items, 21 values, 7 audit rows | `inventory_items`, `inventory_item_values`, `inventory_item_audit` |
| 2 | **14 label runs and their 50 packets** | 14 runs, 50 packets | `raw_material_qr_batches`, `raw_material_qrs` |
| 3 | **Serial counters** for those runs (§4) | 9 raised, 5 new | `raw_material_qr_sequences` |
| 4 | **Store-in session** (PC2's RMI-000185, renumbered), supplier shehzad rubber topping, opened 27 Oct 10:35, closed 12:03, by ranaadeel9720 | 1 session | `raw_material_receiving_sessions` |
| 5 | **50 store-in scans**, plus their 50 RECEIVE stock movements | 50 + 50 | `raw_material_qr_events` (STORE_ENTRY), `inventory_stock_events` (RECEIVE) |
| 6 | **Store-out session** (PC2's RMO-000139, renumbered), opened 27 Oct 19:29, brought in **closed** at its last scan (19:33) | 1 session | `raw_material_issue_sessions` |
| 7 | **29 store-out scans**, Scan Out to **Daniyal** (PTY-000008), 19:30–19:33, plus their 29 TRANSFER_OUT movements. PC2 recorded ASIM SHEHZAD (BHATI), PTY-000019, by mistake. The scan's `metadata_json.issuedToPartyId` is set to Daniyal's party ID (`6bde055a-…`, the same record on both PCs). That field is the only place the recipient is stored: the stock movements carry no party | 29 + 29 | `raw_material_qr_events` (STORE_EXIT), `inventory_stock_events` (TRANSFER_OUT) |
| 8 | **Close PC3's two orphaned sessions**: RMI-000184 (0 scans) and RMO-000137 (1 scan, the same scan on both PCs), using the times PC2 closed them | 2 updates | — |
| 9 | **Guard counters** so old labels can never be printed again (§4.3) | 5 new | — |
| 10 | **Stock balances** for the 14 materials touched: recomputed from the movements, then checked against the expected figures (§6) | ≤ 14 | `inventory_stock_balances` |

**Not brought across:**

- The 38 duplicate store-out scans and their 38 TRANSFER_OUT movements.
- RMO-000138, an empty session PC2 opened at 19:27:54 and closed at 19:29:24, with 0 scans.
- PC2's 15 diverged and 5 PC2-only serial counters, as rows. §4 sets PC3's counters instead.
- `app_users` login timestamps and PC2's own `devices` / `workstations` / `factories` rows.

PC2 has **no unsent sync rows** (`sync_outbox`) for any of this, so nothing there needs copying.

**Kept exactly as on PC2:**

- every record's ID (UUID), creation time and user (ranaadeel9720);
- each scan's device and workstation;
- each stock movement's note ("Raw Material Input RM_6_…").

History therefore shows what really happened and when. Only numbers (§2) and the recipient of the 29
(step 7) change. The `audit_log` entry for the reconciliation records the recipient correction:
from PTY-000019 to PTY-000008, on the storekeeper's confirmation.

---

## 2. Renumbering without colliding with PC3

PC3's next free numbers at copy time: **RMI-000191, RMO-000168, RM-000995**. PC3 keeps working until
the swap, so the script **works these out again at run time** and refuses to run if any number it
picks is taken.

| PC2 number | Becomes on PC3 | Notes |
|---|---|---|
| RMI-000185 (store-in, 50 packets) | **RMI-000191** (next free) | Its date (27 Oct 10:35) is earlier than PC3's RMI-187…190. The order of numbers and dates disagrees for this one session. |
| RMO-000139 (store-out, 67 scans) | **RMO-000168** (next free), with the 29 scans only | Same session ID as on PC2, so each scan's metadata still points at its own session |
| RMO-000138 (empty) | not re-entered | — |
| RM-000965 SK12 BLACK WHITE 7/10 | **RM-000995** | PC3's RM-000965 is PACKING THELLI 12X14 |
| RM-000966 SK12 BROWN ORANGE 7/10 | **RM-000996** | PC3's: PACKING THELLI 9X10 |
| RM-000967 SK30 BROWN CREAM 7/10 | **RM-000997** | PC3's: PIPE AR 7/10. No packets on PC2 |
| RM-000968 SK30 BROWN 7/10 | **RM-000998** | PC3's: PIPE AR 24/29. No packets on PC2 |
| RM-000969 SK12 BLACK WHITE 1/6 | **RM-000999** | PC3's: PIPE KIDS BABY LIGHT |
| RM-000970 SK30 BROWN ORANGE 7/10 | **RM-001000** | PC3's: SK54 BLACK RED 7/10 |
| RM-000971 SK30 GREY NEON 8/10 | **RM-001001** | PC3's: SK54 BLACK NEON 7/10 |

None of PC2's 7 materials already exists on PC3 under another code (checked by name and by
signature), so there is nothing to merge.

**Which device the sessions carry (corrected 28 Oct).** An earlier version of this plan said the
re-entered sessions must carry PC3's device ID, or PC3 would hand out RMI-000191 and RMO-000168
again. That was wrong. `allocateNumberInRange` (`numberRange.ts`) takes the highest number **in this
computer's block**, whichever device wrote it. The device ID only feeds the out-of-range guard. So the
sessions keep **PC2's** device ID, which is the truth, like everything else brought across. The dry
run proves it: the app's own allocator, run on the result, hands out RMI-000192 and RMO-000169 next.

**Paper.** Checked 28 Oct: no receipt, register or slip carries RMI-000185 or RMO-000139, so no
paper names the old numbers.

---

## 3. The 21 packets whose labels name a material code that means something else on PC3

### 3.1 Do they need reprinting? Recommendation: no

A packet ID such as **RM_6_965_3** encodes the supplier's code, the material's code at print time,
and a serial. After renumbering, those packets' material is RM-000995, but their labels still say
965.

**What a scan actually does.** Store-in and store-out check only that a label has the right *shape*
(`parseRawMaterialQrId`, format only). They then look the packet up **by its whole ID**
(`getRawMaterialQrForMovement`), and the material comes from the packet's record, not from the
digits in its ID. The printed sticker shows category, colour and size in words (`qrLabels.tsx`),
not the material code. The cloud doesn't compare an ID's digits with the material either.

So if the 21 packets keep their IDs, every scan resolves to the right material, and what a person
reads on the sticker is right too.

| | **A. Keep the IDs (recommended)** | B. Renumber and reprint |
|---|---|---|
| Physical work | None | Relabel 9 packets in store. The 12 at the contractor's are relabelled if they ever come back |
| Old labels in circulation | Stay valid | Become unknown labels on PC3 (refused, not misread) |
| Matches PC2's history | Exactly, including the movement notes | IDs differ from PC2's records |
| Cost | For 21 packets, the 965…971 inside the ID no longer matches the material code. Nothing reads it | More physical handling and more room for error |
| Can the app do it? | No: the app always builds an ID from the current code. Needs the script | Partly: §5 |

Under **both** options the guard counters in §4.3 are required, because the old stickers exist
physically either way.

### 3.2 How to find them

All 21 are from supplier shehzad rubber topping, were printed 27 Oct 10:31–10:49 and were received
in RMI-000185:

| Where | Label IDs | Material (as printed on the sticker) | Per packet |
|---|---|---|---|
| **In the store** (9) | RM_6_966_1 … 4 | SK12 BROWN ORANGE 7/10 | 2 DOZEN |
| | RM_6_970_1 … 4 | SK30 BROWN ORANGE 7/10 | 2 DOZEN |
| | RM_6_971_1 | SK30 GREY NEON 8/10 | 3 DOZEN |
| **Issued to Daniyal**, 27 Oct 19:30–19:33 (12) | RM_6_965_1 … 5 | SK12 BLACK WHITE 7/10 | 2 DOZEN |
| | RM_6_969_1 … 7 | SK12 BLACK WHITE 1/6 | 3 DOZEN |

For step 0.3, **all 21 in-store PC2 packets** are the 9 above plus 12 on materials PC3 already
has: RM_6_560_39 (SK12 BLACK GREY 7/10), RM_6_570_22…25 (SK12 BLACK RED 8/10), RM_6_957_9…14
(SK57 BLACK NEON 7/10) and RM_6_901_6 (SK30 GREY NEON 11/13). Those 12 keep their IDs under either
option. Their materials kept their codes.

---

## 4. Serial counters: no future label repeats one already printed

### 4.1 The 9 pairs where PC2 is ahead: they line up exactly

For each existing material PC2 printed after the split, PC3's counter is **exactly one below where
PC2's run started**. PC3 never printed for these pairs afterwards.

| Material (supplier PTY-000006) | PC3 counter | PC2 run | PC3 counter after |
|---|---|---|---|
| RM-000560 SK12 BLACK GREY 7/10 | 38 | 39 | 39 |
| RM-000570 SK12 BLACK RED 8/10 | 21 | 22–25 | 25 |
| RM-000609 SK30 BLACK WHITE 7/10 | 10 | 11–14 | 14 |
| RM-000637 SK46 BLACK RED 7/10 | 29 | 30–31 | 31 |
| RM-000662 SK46 BLACK NEON 7/10 | 21 | 22–25 | 25 |
| RM-000663 SK46 BLACK RED 1/6 | 26 | 27–29 | 29 |
| RM-000676 SK46 BLACK NEON 1/6 | 14 | 15–18 | 18 |
| RM-000901 SK30 GREY NEON 11/13 | 5 | 6 | 6 |
| RM-000957 SK57 BLACK NEON 7/10 | 8 | 9–14 | 14 |

Bringing the runs across raises each counter to the end of PC2's run. **Preflight:** at run time the
script checks every counter is still exactly as above and **stops** otherwise. A higher counter
means PC3 printed for that pair after the copy, which step 0.2 exists to prevent, and the duplicate
stickers would have to be dealt with first.

### 4.2 The other pairs

- **6 pairs where PC3 is ahead, and 8 counters only on PC3:** PC3 is right. Nothing changes.
- **5 counters only on PC2:** these are supplier PTY-000006 × PC2's new materials, at 5, 4, 7, 4
  and 1. They come across with the materials under the materials' original IDs. The next run of
  SK12 BLACK WHITE 7/10 then prints RM_6_995_6.

### 4.3 Guard counters for the old stickers

The old stickers RM_6_965_1…5, RM_6_966_1…4, RM_6_969_1…7, RM_6_970_1…4 and RM_6_971_1 exist
physically, 12 of them at a contractor's. PC3 has **no** counter for supplier PTY-000006 × its own
RM-000965, 966, 969, 970 or 971 (checked). A first run for any of these would therefore start at
serial 1 and print exactly those strings again, for a different material.

So the script inserts counters for PTY-000006 × **PC3's** RM-000965 at 5, 966 at 4, 969 at 7, 970 at
4, and 971 at 1. The app has no screen for this, so it is unavoidably a direct database step.

### 4.4 The root cause: both PCs hold number block 1

Both PCs hold number block 1 because PC3 was made by copying PC2's database. PC3 is retired (§8), so
this stops mattering once PC3 never prints again. If PC3 ever comes back, it must be **provisioned
fresh from the cloud with its own block** (docs/37), never from a copy of either file. For a PC that
syncs, the cloud now enforces this (migration 018, §7 item 3): a second PC claiming block 1 is refused.

---

## 5. Through the app, or direct database work?

| Step | Through the app? |
|---|---|
| 7 materials | **Yes**, typed by hand. Today's date and user, and new UUIDs |
| 9 runs on existing materials | **Yes, with a catch.** Same serials, because of §4.1. But one press of Print both registers **and prints** (`LabelsTab.tsx`), so it prints a duplicate of a sticker that is already on a packet. These must be destroyed at once |
| 5 runs on new materials | Only as option B (new IDs and reprint). The app can't keep the old IDs |
| Store-in of 50 | **Yes**, but 29 of those packets have left the store. Their labels are only available as the duplicates above |
| Store-out of 29 to Daniyal | **Yes** (Scan Out) |
| Close RMI-184 / RMO-137 on PC3 | Probably. Not verified: they were opened under PC2's device ID |
| Guard counters (§4.3) | **No.** Direct database only |
| Original dates, users and IDs | **No.** Everything would be dated the day of re-entry |

**Recommendation: one reviewed, one-time script.** By hand the app can do most of it, but:

- every receipt and issue would be dated the day of re-entry, not 27 Oct;
- it prints duplicate stickers;
- it can't keep the 21 IDs;
- it still needs a direct database step for §4.3.

How the script is run and checked:

1. **Written in this repo with tests**, reviewed before use. It inserts PC2's rows with the changes
   in §2, sets counters as in §4, and recomputes balances.
2. **Dry run today** on the copies. The result is compared with PC2 using the existing diff
   tooling (§6).
3. **Real run at swap time:**
   - close PC3 and copy its file (with `-wal`/`-shm`);
   - run the script on the copy;
   - verify;
   - put the old file aside as the backup and the reconciled file in place;
   - open PC3 and spot-check.

   About 30 minutes of PC3 downtime.

The script writes tables directly instead of going through the store-in and store-out use cases,
because those always stamp "now". That is the trade-off for keeping the true history. The checks in
§6 are what stand in for the use cases' own validation.

---

## 6. Verification (dry run and real run)

1. **Diff against PC2.** The only PC2 rows still missing are exactly:
   - the 38 STORE_EXIT scans and their 38 TRANSFER_OUT movements;
   - RMO-000138;
   - PC2's counters, users, devices and workstations.

   Nothing else.
2. **Stock adds up.** The backfill's own check (`stockMismatches`) finds no material whose balance
   differs from the sum of its movements.
3. **Expected balances.**

   | Material | Expected balance |
   |---|---|
   | RM-000560 | 34 |
   | RM-000570 | 24 |
   | RM-000957 | 12 |
   | RM-000901 | 3 |
   | RM-000609, 637, 662, 663, 676 | unchanged (each received and issued in full) |
   | RM-000996, RM-001000 | 8 each |
   | RM-001001 | 3 |
   | RM-000995, RM-000999 | 0 |
   | RM-000997, RM-000998 | no movements |

   The 21 in-store packets add 48 DOZEN to the store, and 120 DOZEN in less 72 DOZEN out leaves 48.
4. **Packet state.** Each of the 50 packets' current status equals its last scan:
   - 21 IN_STORE;
   - 29 ISSUED.
5. **Recipient.** All 29 re-entered store-outs name Daniyal (PTY-000008), and none names PTY-000019.
   Together with PC3's RMO-000167, Daniyal's store-outs on 27 Oct come to 70 packets and 211 DOZEN.
6. **Numbers.** PC3's next numbers are the one after RMI-000191, the one after RMO-000168, and
   RM-001002. Serial checks:
   - a test run for PTY-000006 × PC3's RM-000965 would start at 6;
   - a test run for RM-000560 would start at 40.
7. **In the app, on a test instance with the reconciled copy** (never PC3 itself):
   - the stock screen shows the figures above;
   - the journey of RM_6_965_3 shows SK12 BLACK WHITE 7/10, in, then out to Daniyal;
   - RM_6_966_1 is accepted by a Store Out scan.

---

## 7. Would the lease system have prevented this?

Assumption: both PCs enrolled, syncing, on the 0.4.0 build.

**Yes, for everything that went wrong here, if PC2 was online.**

- **One store PC.** Label printing, store-in, store-out and material creation are leased
  (`leaseChannels.ts`: RAW_MATERIAL_STORE and MASTER_DATA). Only the holder of each can do them.
  Every write PC2 made would have been refused at the click with "read-only on this computer".
  There would have been nothing to reconcile.
- **The 38 double store-outs would have been refused even without leases.** PC2 would have pulled
  PC3's 19:05 scans within seconds (realtime) and refused the 19:30 scans as already issued.

**Not fully, in four cases:**

1. **PC2 offline with an out-of-date lease.** Say PC2 held the lease, went offline, and the lease
   moved to PC3. PC2 decides from its cached lease, so it keeps writing locally. Every push is then
   refused (NOT_LEASE_HOLDER) and shows up as a dead letter on Health. The damage is the same kind
   but smaller and visible at once, and it still needs reconciling by hand.
2. **A PC made by copying a database, and never enrolled.** The lease gate lets a computer that
   isn't set up for sync write as before (`leaseWriteDecision`, `syncConfigured: false`). That is
   how this incident happened, so leases would not have stopped it. docs/37 already says a new PC is
   provisioned from the cloud, never by copying a file.
3. **Duplicate number blocks.** Leases stop two PCs writing at the same time, but they don't stop two
   PCs sharing a block. The cloud has **no record of number blocks** at all (nothing in
   `migrations/supabase`). If two enrolled PCs were both on block 1, a lease hand-over would let the
   new holder issue codes and serials the previous holder already used. A duplicate serial would be
   refused at print time, because the packet already exists locally. That is safe, but printing is
   stuck until it's fixed. **Recommended addition before go-live:** the cloud records each enrolled
   PC's block and refuses an enrolment whose block is already taken.
   **Built, 30 Oct (not yet applied):** cloud migration 018. The claim carries the PC's block; the
   first PC to claim a block holds it, a second is refused `NUMBER_BLOCK_TAKEN` and every write it
   tries is refused too. Only the owner can move a block (`reassign_number_block`, with a reason).
   `check_number_blocks.sql` proves it on test once 018 is applied.
4. **Domains not enforced yet** (sales and dispatch, accounts, machine programs, approvals) are
   unprotected until Milestone 2. This incident didn't touch them.

---

## 8. Change to the production path

The approved path rehearsed step 3 with "a fresh copy of PC2's database". As of 28 Oct, the
reconciled database runs on **PC2**, the store machine:

- the **reconciled database, now on PC2**, is the source for go-live. The rehearsal (28 Oct) ran on
  a copy of the same reconciled file;
- **PC3 is retired.** It still holds a database on number block 1, so it must stay switched off.
  If it ever returns, it is installed fresh and provisioned from the cloud with its own block,
  never from a copy of any file.

---

## 9. Open questions for the owner

1. ~~Which contractor received the packets?~~ **Answered:** Daniyal, all 67. PC2's ASIM SHEHZAD
   (BHATI) was a mis-selection. Still to do: the storekeeper checks 127 + 72 = 199 DOZEN (or 211
   with the 3 extra packets on PC3's RMO-000167) against what he handed over.
   **Done 28 Oct:** the storekeeper confirmed 211 DOZEN to Daniyal against the physical handover.
2. **Option A (keep the 21 IDs) or B (renumber and reprint)?** The script implements A, the
   recommendation. Say so if you want B instead.
3. ~~Script or re-entry through the app?~~ **Answered:** script.
4. ~~Was anything printed or written with RMI-000185 or RMO-000139?~~ **Answered 28 Oct:** nothing
   was written on paper, so nothing needs annotating.

---

## 10. As built, and the dry run (28 Oct 2026)

**Code.**

- `packages/data/src/database/storeReconciliation/`:
  - `shared.ts`: types and readers;
  - `classify.ts`: sessions, scans, stock movements;
  - `stock.ts`: materials, runs, counters, balances;
  - `plan.ts`: preflight and plan;
  - `apply.ts`: one transaction;
  - `verify.ts`: ten checks.
- `scripts/reconcile-pc2-pc3.mjs` holds the decisions above and runs it.
- The module isn't exported from `@erp/data` and isn't reachable from the app.
- `numberExpression` in `numberRange.ts` is now exported, so the next-number query is the
  allocator's own.

**How it refuses rather than guesses.**

- Both files must be at migration 087 and carry the PC2 and PC3 device IDs.
- Every PC2-only row in any table must sort into "bring" or "leave". Only `user_sessions` (logins) is
  ignored.
- Every count must equal the reviewed plan's.
- PC3's counter for each of the 9 shared materials must still stand one below PC2's run.
- Each of the 38 duplicates must show on PC3 as issued to Daniyal.
- Units must match, and no balance may go negative.
- Every update names what the row must still hold. If anything moved between planning and writing,
  the whole transaction rolls back.

**Tests.** `packages/data/src/storeReconciliation.test.ts`, 15 tests, all passing. They run on a
small model of the incident, built at migration 087:
- the happy path, with all ten checks passing;
- renumbering, recipients and the duplicates left behind;
- balances;
- that no label can be printed twice, including the guard;
- the app's own allocator run on the result;
- the stale-session closes;
- the refusals: a counter that moved, swapped files, an unaccounted row, a wrong-recipient duplicate,
  wrong counts;
- a rollback when the target changed between planning and writing;
- a second run refusing;
- the checker catching tampering.

As a mutation check, disabling the guard counters made two tests fail, the guard test and the
checker's own label check.

**Dry run.** On the scratchpad copies, whose hashes equal the originals'. All ten checks passed. Both
inputs were hashed before and after and are unchanged.

- Materials RM-000965…971 became RM-000995…RM-001001.
- RMI-000185 became RMI-000191 with 50 scans, and RMO-000139 became RMO-000168 with 29 scans.
- RMI-000184 and RMO-000137 were closed at PC2's times.
- Counters: 9 RAISE, 5 NEW, and 5 GUARD on PC3's own RM-000965/966/969/970/971.
- Balances came out exactly as §6.3.
- 275 rows were inserted, 20 updated, and 77 left behind (38 store-outs, their 38 movements, and
  RMO-000138).
- All 104 tables were compared row by row, and nothing else changed.

**Independent cross-check** (separate code, not the module's own checks):

- **What's still missing from PC2:** exactly the 38 scans, the 38 movements, 1 session and 2 login
  sessions.
- **Daniyal:** RMO-000167 and RMO-000168 hold 70 packets and 211 DOZEN for him, the storekeeper's
  figure.
- **ASIM SHEHZAD:** none of the brought store-outs names him. His 20 store-outs that day are PC3's
  own, from RMO-000147 and RMO-000164…166, and are untouched.
- **PC2's 50 packets:** 21 in store (48 DOZEN) and 29 issued.

**Upgrade and app check.** A further copy of the result, upgraded to this branch's schema (098), was
checked with the app's own code:

- the backfill preflight finds 0 materials whose stock doesn't add up;
- the journeys of RM_6_965_3, RM_6_966_1 and RM_6_560_39 resolve to the right materials and states;
- the app would allocate RMI-000192, RMO-000169 and RM-001002 next;
- printing for shehzad gives:
  - RM_6_965_6 for PC3's own THELLI, not RM_6_965_1;
  - RM_6_971_2 for SK54 BLACK NEON;
  - RM_6_995_6 for SK12 BLACK WHITE 7/10;
  - RM_6_560_40 for SK12 BLACK GREY.

**The real run (28 Oct 2026).** The owner confirmed that both PCs had stayed closed since the 27 Oct
copies and that no shehzad labels had been printed. So the real run used those same copies, still
byte-identical to the originals.

- All ten checks passed, and the inputs were unchanged.
- The figures are identical to the dry run.
- The output is at migration 087 and is a single file, sha256
  `d87f34d7bcf0c9476f4fc4a9dee32bb560e2a6d617289474feb0c604cc77bbe9`.
- Daniyal: RMO-000167 and RMO-000168 hold 70 packets and 211 DOZEN.

Next: the owner reviews a separate viewing copy in a dev instance, then swaps the output into PC3.
