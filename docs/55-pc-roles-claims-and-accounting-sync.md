# 55: The three computers, claims, and accounting that travels

21 Nov 2026. Builds on docs/37 (leases), docs/43 (bills and cash travel), docs/51 (PARTIES), docs/53 (opening
balances) and docs/54 (purchase bills). The architecture is the owner's, fixed on 21 Nov 2026.

## 1. Who does what

| Computer | Role | Writes |
|---|---|---|
| **PC1**, "PC1 - MOEEZKHAN" | Central accounts and production | All accounting: sale bills, gatepasses, orders, purchase bills, cash vouchers, opening balances, ledger imports, **claims** (price, post, reject, reverse). Parties. Manual Production, production days, stock adjustments. Products and master data. |
| **PC2**, "DESKTOP-R1V8" | Store only | Raw material store: receipts, issues, labels, Move In/Out vouchers, machine-program store steps, **closing a program** (cut size, and **claim requests**: no money). |
| **PC3**, "PC3 - boss (DESKTOP-SQL0)" (device d223d895…) | Boss: customer orders, otherwise viewing | Customer orders only (ORDERS, cloud 042, 24 Nov 2026): enter, edit and cancel. Everything else read-only. |

The workstation names are as the production cloud lists them (read 21 Nov 2026). PC3's name is inferred: it is the third
registered computer, and it holds no lease.

## 2. Leases

### What production holds now (read from the production cloud, 21 Nov 2026, select only)

| Domain | Holder | Epoch |
|---|---|---|
| ACCOUNTS | PC1 | 2 |
| SALES_DISPATCH | PC1 | 2 |
| CARTON_STOCK | PC1 | 2 |
| MASTER_DATA | PC1 | 4 |
| RAW_MATERIAL_STORE | DESKTOP-R1V8 (PC2) | 1 |
| MACHINE_PROGRAMS, APPROVALS | nobody (not enforced) | 0 |
| PARTIES | **does not exist yet** (035 not applied) | |

### What each lease protects (main/leaseChannels.ts, syncEvents.ts)

| Domain | Owner | Writes it protects | Records it travels |
|---|---|---|---|
| ACCOUNTS | PC1 | cash vouchers, opening balances (single and bulk), ledger import and withdrawal, purchase bills, **claim post/reject/reverse** | CASH_VOUCHER, LEDGER_ARCHIVE_STATEMENT, PARTY_OPENING_BALANCE, PURCHASE_VOUCHER, **PARTY_CLAIM, PARTY_CLAIM_REJECTION** |
| SALES_DISPATCH | PC1 | sale bills and their lines, gatepass bills, delivery proof, gatepass allocations against orders, sale return scan (on the QR hold) | SALE_VOUCHER, GATEPASS, GATEPASS_ORDER_ALLOCATION, **SALE_RETURN** |
| ORDERS | **PC3** (24 Nov 2026, cloud 042) | enter, edit and cancel customer orders | CUSTOMER_ORDER |
| CARTON_STOCK | PC1 | Manual Production (record, save, edit, void), Complete today's production, carton stock adjustments, **gatepass create/cancel (with SALES_DISPATCH)** | MANUAL_PRODUCTION_ENTRY, PRODUCTION_DAY, CARTON_STOCK_ADJUSTMENT, CARTON_STOCK_EVENT |
| PARTIES | PC1 | create/edit/delete parties and party groups | PARTY, PARTY_GROUP |
| MASTER_DATA | PC1 | products, colours, machines, work sections, colour list | the product and machine records |
| RAW_MATERIAL_STORE | PC2 | everything in the store, materials and units, **closing a machine program** | INVENTORY_*, STOCK_EVENT, STORE_HAND_VOUCHER, raw-material QR, **PARTY_CLAIM_REQUEST** |

Every CARTON_STOCK workflow is PC1's work (Manual Production and gatepasses are on PC1), so CARTON_STOCK stays on PC1
whole. No lease is split. PC3 holds ORDERS only (from cloud 042), so the gate refuses every other leased write there.

### Changes needed in production

1. **PARTIES**: apply 035 (revised: it now says PARTIES is PC1's), then grant PARTIES to PC1. Nothing else moves.
2. Nothing else: ACCOUNTS, SALES_DISPATCH, CARTON_STOCK and MASTER_DATA are already PC1's, and the store's lease is
   PC2's. PC2 must never be granted ACCOUNTS or PARTIES.

**Release-order catch, found in this work.** A release that knows PARTIES refuses party writes on PC1 with
`NO_LEASE_INFO` until 035 is applied and PARTIES is granted (leases.ts decideLeaseWrite: a synced computer with no
lease row for a domain may not write it). Install the release on PC1, apply 035, and grant PARTIES in one sitting.

## 3. Claims

### Before this work
Closing a machine program on PC2 posted the claim itself, at an amount the store typed, onto the party's ledger, on PC2
only. Machine programs do not travel, so PC1 never saw a claim, and an accounting figure was decided on the store
computer.

### Now

```
PC2  Program close                        PC1  Claims screen                          PC2, PC3, PC1
     ─────────────                             ─────────────                               ──────────
     2 pairs torn → claim REQUEST  ──────────▶  CR-200001 waiting
     CR-200001: party, material,               Accounts types Rs 50 a pair
     pairs, reason, program code.              2 × Rs 50 = Rs 100 → Post  ───────────────▶  CL-000017 on the
     No money. Same transaction                                                             party's ledger
     as the closure.                           Reverse (reason)  ───────────────────────▶  off every ledger,
                                               Reject (reason)   ───────────────────────▶  kept with why
```

- **The request** (`party_claim_requests`, local 116) is written in the program's closing transaction, so the close
  and its requests are all or nothing. It counts towards the closing rule exactly as a claim did (cut size + claimed
  pairs = the shortfall, to the pair). It holds the party and role, the material id and name, the program id and code,
  the upper line id, pairs, reason, the business date, who and when, and the originating computer. It carries no
  money and moves no balance, stock or cash. It travels as `PARTY_CLAIM_REQUEST` under the store's lease.
- **The claim** (`party_claims`, rebuilt by 116) is posted on PC1 from a request: the amount a pair is Accounts',
  checked as whole paisa (at most Rs 100,000 a pair), and the total is pairs × amount. It carries the program code
  and material name as text, so the ledger line reads the same on a computer that never had the program. It travels as
  `PARTY_CLAIM` under ACCOUNTS. A reversal is a new revision of the same record, with who, when and why. It is
  kept, and the request waits again to be posted at the right amount.
- **The rejection** (`party_claim_rejections`) says nothing is claimed, and why. It is final. It travels as
  `PARTY_CLAIM_REJECTION` under ACCOUNTS.
- **Status** is worked out, never stored: rejected, else posted if a POSTED claim exists, else waiting. So each
  record is written only by the computer that owns it, and the store's request is never changed by Accounts.
- **Duplicates.** A request has at most one POSTED claim (partial unique index). The screen sends a new claim id
  per attempt, so a retry of a post that went through is answered with that claim, not a second one. Every
  revision is idempotent on delivery (DUPLICATE).
- **Who.** Posting, rejecting and reversing need an **administrator** (owner, 21 Nov 2026; `requireAdmin` in
  main/ipc/partyClaims.ts) **and** the ACCOUNTS lease (the gate refuses them on PC2 and PC3, whatever the renderer
  sends). There is no permission that lets anyone else post: other users on PC1 only view, until the owner
  authorises more. Reading needs *Claims (view)* (`party-claims`), which nobody holds by default; administrators
  hold every permission.
- **Nothing else moves.** No stock, cash, production, program or carton figure is written by a request, a claim, a
  reversal or a rejection, anywhere. Cut size is exactly as before.

### Historical claims (posted on PC2 before this release)
They stay on PC2 and keep counting on PC2's ledgers, as now. They are **not** sent, by the release or by the backfill:
the backfill marks a type only under a lease the computer holds, and PC2 does not hold ACCOUNTS. PC1 and PC3 do not see
them, as today.

**Transfer plan, for authorisation (not built, not run):**
1. On PC2, count them: `SELECT COUNT(*), SUM(amount_paisa) FROM party_claims WHERE request_id IS NULL AND status = 'POSTED'`.
   If there are none, nothing is needed.
2. A one-time tool on PC2 writes a claim request for each, linked to it, with its pairs, material, program code and
   reason (store lease, allowed). They reach PC1.
3. A one-time tool on PC1 posts each **under the historical claim's own id and number**, at its original amount a pair,
   with the origin device stamped as PC2 (so PC1's number-range guard does not count PC2's CL- numbers as its own).
4. When PC2 receives those claims, the generic contract upserts by id: the row PC2 already has gains its request link
   and stays one row. No claim is duplicated, and no balance moves on PC2. PC1 and PC3 gain the same rows, and their
   supplier and contractor balances then match PC2's.
5. Check: the same count and sum on all three, and each affected party's balance equal on all three.

## 4. What travels now, and what each computer's balances read

| Record | Written on | Travels | Status |
|---|---|---|---|
| Sale bills, gatepasses, orders | PC1 | yes (028, 036) | both projects |
| Cash vouchers (receipts and payments) | PC1 | yes (028) | both projects |
| Opening balances | PC1 | yes (037) | both projects |
| Ledger archives and withdrawals | PC1 | yes (034) | both projects |
| Purchase bills | PC1 | **yes, from this release** (038) | both projects |
| Claim requests | PC2 | **yes, from this release** (039) | both projects |
| Claims, reversals, rejections | PC1 | **yes, from this release** (039) | both projects |
| Sale returns | PC1 | **yes, from this release** (040), after Carton Cloud activation, like bills | both projects |
| Customer discount rules | any | no (docs/43) | unchanged: they belong to the computer they were made on |

So, for everything written from this release on, the three computers compute every customer, supplier and
contractor balance from the same records. Two older gaps remain until their authorised transfers: purchase bills
stored before this release (docs/54) and historical claims (above). For that reason **Supplier Ledger and Supplier
Balance still show only on the ACCOUNTS holder** (`ledgerVisibility.ts`, unchanged). PC3 would show a supplier balance
missing older bills and claims. Once both transfers are done and checked, that one rule is changed to show them
read-only everywhere (a one-line change and a release). Customer and contractor ledgers already show on every
computer.

## 5. Sale returns
A return is recorded only by the QR return scan, on the sales holder (PC1), and the scan is on the carton QR hold.
So no new return can be recorded in this release. Before this work a return never left PC1, and PC2 and PC3 customer
balances would have been too high by it. Now `SALE_RETURN` travels under SALES_DISPATCH as a stock document: sent
only after Carton Cloud activation, and never one recorded before activation (the cutoff always covered
`sale_returns`, and its table list is unchanged, so activations already made stay valid). A return cancelled with its
bill travels as a new revision of it. Its numbering stays local, which is safe because only the sales holder writes
returns, and a new holder will have received every earlier one. **Apply 040 before the QR hold is lifted.** Returns
recorded after activation but before this release are not sent (no capture then). Count them on PC1 (`SELECT
COUNT(*) FROM live_sale_returns`) before lifting the hold. Any found need a separate, authorised transfer.

## 6. Cloud migrations: verified state and order

Re-verified 21 Nov 2026 (afternoon) against both projects' `leased_record_types` and migration history. Production was
read with select only. Both now hold the same 31 type rows:

| | Production | TEST |
|---|---|---|
| 030–033 (adjustments, store-lease taxonomy, production days, Move In vouchers) | applied | applied 21 Nov 11:11–11:12 UTC (history 20261121111156–111220) |
| 034, 036, 037 | applied 21 Nov 08:56 UTC (in another session, owner's "Production only") | applied 19 Nov |
| 035 PARTIES | **no** | **no** |
| 038, 039, 040 | applied 21 Nov 08:56 UTC (same session) | applied 21 Nov 11:12 UTC (history 20261121111222–111224) |

Before TEST was written, `C:\Projects\777-test-cloud-backups\2026-11-21-before-030-033-038-040.json` recorded every row
those migrations change, as a pre-image (rows only; their down files undo them). `check_party_claim_records.sql` then
passed on TEST (rolled back, nothing kept: leases, log at seq 27656, workstations and blocks unchanged). It runs the
real `push_leased_record`:
- with only the store lease, a request lands, and a claim, rejection, purchase bill or sale return is refused
  NOT_LEASE_HOLDER;
- with ACCOUNTS, a claim, its reversal, a duplicate (DUPLICATE), a rejection and a bill land, and a request is refused;
- a sale return lands only from the SALES_DISPATCH holder;
- each revision is logged once.

Dependencies: 034, 036, 038, 039 need only 011 and 013. 037 needs 034. 040 needs 028. 035 needs 011 and 013 and
must come after every computer runs a release that knows PARTIES. None of 034–040 needs another of them except 037
on 034.

**Order for production** (step 1 is already done):
1. 034, 036, 037, 038, 039, 040 (rows only; any computer still on the old release never sends these types). DONE.
2. Release (local 111–116) to PC2 and PC3, then PC1, in one sitting.
3. 035, then grant PARTIES to PC1, straight after PC1 is on the release (section 2).
4. Authorised transfers, each checked: older purchase bills (docs/54), historical claims (section 3), and any
   post-activation sale returns (section 5).
5. Then, in a later release: supplier ledgers read-only on PC2 and PC3 (section 4).

Rehearse on TEST first. The TEST cloud is ready (above). The three-computer rehearsal is blocked on devices:
- TEST Auth has no user for W3 (`C:\Projects\erp-wf-w3`, device 8a51ea43…, block 97) or W4
  (`C:\Projects\erp-wf-w4`, device 68fc3fe0…, block 98);
- there is no third clean workspace;
- TEST's store lease is held by `dev-gate-holder`, a developer's dev instance, and taking it over could disrupt that
  instance.

## 7. Tests
- `packages/sync/src/claimSync.test.ts`, three real databases (store, accounts, boss):
  - a request travels;
  - Accounts posts, retries, reverses and re-posts;
  - a second request is rejected;
  - all three agree on status and supplier balance after every step;
  - deliveries twice change nothing;
  - no reader marks what it received;
  - no stock, cash, carton or purchase figure moves;
  - a claim arriving before its request waits.
- `packages/sync/src/saleReturnSync.test.ts`: a return credits the customer once on both computers, and its
  cancellation with the bill travels.
- `packages/data/src/upperReconciliation.test.ts`, `machineProgramStoreOut.test.ts`:
  - the close records requests in its own transaction;
  - the balancing rule is unchanged;
  - no claim is posted by the store;
  - a failed close records nothing;
  - Accounts' post puts the same figure on the supplier and contractor ledgers as before.
- `apps/desktop/src/main/leaseGuard.test.ts`: the real claim handlers through the real gate and the real Authorizer:
  - refused on PC2 and PC3 before the data layer runs;
  - read everywhere;
  - posted on the holder by an administrator;
  - refused to a non-administrator with Claims (view) on the holder;
  - refused with no session.
- `apps/desktop/src/renderer/features/claims/ClaimsPage.test.tsx`:
  - pricing preview, posting, refusal text, rejection and reversal reasons;
  - read-only off the holder and without the permission;
  - empty and error states.
- `migrations/supabase/check_party_claim_records.sql`: passed on TEST, 21 Nov (section 6).
- **Not done:** a cross-computer app run against the TEST cloud. It is blocked on TEST device accounts (section 6).
