# 51 — Parties on their own lease, held by the accounts computer (PC1)

> **REVISED 21 Nov 2026 (docs/55).** The owner has fixed the computers' roles: **PC1 creates and edits every party, and
> PC2 must never hold PARTIES.** The lease, its mechanism and cloud 035 are unchanged (035 was never applied, and its
> text says PC1). Every step below names PC1. The first decision (16 Nov, PARTIES on PC2) is kept only as history in
> the next paragraph.

History, 16 Nov 2026: the owner first asked for PC2's store operator to add new parties (Option C, PARTIES on PC2).
That was replaced on 21 Nov by docs/55 before anything was applied: PARTIES is PC1's.

## The rule now

| Lease | Holder | Writes |
|---|---|---|
| MASTER_DATA | PC1 (`fd435526…`) | products and their grouping, article sizes, machines, work sections, colours |
| **PARTIES** (new) | **PC1 (`fd435526…`)** | **parties and party groups** (customers, suppliers, contractors) |
| RAW_MATERIAL_STORE | PC2 (`47c0dace…`, store) | units, ladders, categories, materials, their stock, labels and packets |

PC2 must never be granted PARTIES (or ACCOUNTS). Its store screens choose from the parties PC1 sends.

Every computer still reads every party: PC2 and PC3 receive PC1's parties and party groups as before. A computer
writes parties only when it holds PARTIES, is caught up past its barrier, and the person signed in has the
**Party Form** permission (`party-form`), exactly as before.

This is the same move cloud 031 made for raw-material master data (docs/47), with one difference: parties get a
domain of their own, the way CARTON_STOCK did in cloud 026.

## What changed

**App (this repository, uncommitted):**

- `@erp/domain` `LEASE_DOMAIN.PARTIES`.
- `@erp/data` `LEASED_AGGREGATE_DOMAIN`: `PARTY_GROUP` and `PARTY` → PARTIES. Capture triggers stamp a party
  change with the PARTIES epoch (they are rebuilt from this mapping at every start), the builder sends it under that
  epoch, and send-again and the backfill look the lease up per type, so they follow without change.
- `apps/desktop` `leaseChannels.ts`: `createParty`, `updateParty`, `deleteParty`, `createPartyGroup` → PARTIES.
  Party Form and Party List show the PARTIES read-only notice. "Parties" is added to the lease wording, and
  MASTER_DATA's wording no longer says parties.
- **No local migration.** The lease cache (`sync_domain_leases`, local 093) stores any domain name, the outbox's
  record types are unchanged, and the capture triggers are rebuilt at start. The highest local migration stays 111.

**Cloud: migration 035 (`migrations/supabase/035_parties_lease.up.sql`), prepared, not applied anywhere.** Rows only:

1. `lease_domains` gains PARTIES.
2. `domain_leases` gains the PARTIES row, **held by nobody**, with `barrier_seq` at the last PARTY or PARTY_GROUP
   revision in `sync_event_log`.
3. `leased_record_types`: PARTY and PARTY_GROUP → PARTIES.

Nothing is granted, released or taken over. MASTER_DATA's holder, epoch and barrier are not touched, and no party,
ledger, voucher or log row changes. `push_leased_record` reads a type's domain on every push, so the cloud enforces
the new lease with no new function.

**Why the barrier.** A new domain would start at barrier 0. Parties were written by PC1 under MASTER_DATA, so the
holder of PARTIES must not write a party until it has pulled all of them (011's catch-up rule). The barrier makes the
holder refuse its own party writes, showing "catching up", until its pull passes the last party revision. PC1 wrote
every party since 10 Nov itself (production log read 21 Nov: last party seq 31599, from PC1), so it is caught up.

## Safety

- **Retries and duplicates:** a party revision is idempotent in the cloud (013: same revision and body = DUPLICATE),
  and a second delivery to a receiver is ignored (tested).
- **Offline:** PC1 writes parties offline as the PARTIES holder; they queue with the PARTIES epoch and go when it
  reconnects. Nothing else changes.
- **Conflicts:** one writer. A party written on a computer without PARTIES is refused locally by the write gate, and,
  if it was written on an old release, refused by the cloud NOT_LEASE_HOLDER and parked in that computer's dead
  letters. It never reaches another computer (tested).
- **Stale holder:** if PARTIES ever moves away from its holder, that computer's later party writes are refused by
  epoch (tested).
- **Older releases:** a release that does not know PARTIES skips it in `current_leases()` and still applies parties,
  whoever wrote them.

## Deployment order (each production step needs the owner's separate authorisation)

1. **Release** the app with this change (as usual: tag, workflow). Install it on **PC1, PC2 and PC3**. From this
   moment parties are read-only everywhere (no computer holds PARTIES yet). Every other domain works as before.
   - Before installing on PC1, let it finish syncing: its party changes queued under MASTER_DATA still go after the
     upgrade, as long as 035 is not applied yet (the cloud still checks MASTER_DATA for parties).
2. **Check PC1 has nothing left to send for parties.** On PC1, Sync health shows nothing waiting, unsent or parked.
   The cloud cannot see a computer's local outbox, so this is PC1's own check. A party change PC1 has not sent by the
   time 035 is applied is refused NOT_LEASE_HOLDER and parked in its dead letters: visible, never merged.
3. **Apply cloud 035** (production; TEST first if a TEST run is wanted). Check before and after:

   ```sql
   select aggregate_type, lease_domain from public.leased_record_types where aggregate_type in ('PARTY', 'PARTY_GROUP');
   select domain, holder_device_id, epoch, barrier_seq from public.domain_leases where domain in ('MASTER_DATA', 'PARTIES');
   ```

   Expected after: both types PARTIES; MASTER_DATA unchanged; PARTIES holder null, epoch 0, barrier = last party seq.
4. **Grant PARTIES to PC1** (production, owner only, the established procedure of docs/36 7.6 and 011), in the same
   sitting as step 3 and right after PC1 is on the release (docs/55 section 2: until then PC1's party writes are
   refused `NO_LEASE_INFO`):

   ```sql
   select public.grant_domain_lease(
     'PARTIES',
     'fd435526-69ba-45f9-bfa0-c1f5933433cd',   -- PC1, "PC1 - writer (MOEEZKHAN)" (read 21 Nov 2026: confirm before running)
     'PC1 accounts -- parties'
   );
   ```

   Confirm PC1's device id first. It must be the computer that already holds ACCOUNTS and MASTER_DATA:

   ```sql
   select device_id, label, is_active, revoked_at, workstation_id from public.device_accounts where device_id = 'fd435526-69ba-45f9-bfa0-c1f5933433cd';
   select domain, holder_device_id from public.domain_leases where domain in ('ACCOUNTS', 'MASTER_DATA');
   ```

   Expected answer: `{"accepted": true, "epoch": 1, "barrierSeq": <the last party seq>, "tookOverFrom": null}`.
   **Never grant PARTIES to PC2** (`47c0dace…`, DESKTOP-R1V8).
5. **On PC1**, sync once. Party List and Party Form stop showing read-only once PC1 has pulled past the barrier. A
   party saved on PC1 then appears on PC2 and PC3.
6. **Permission**: unchanged. Whoever already edits parties on PC1 keeps **Party Form** (`party-form`).

**Rollback:** before step 4, `035_parties_lease.down.sql` returns both types to MASTER_DATA and removes the unheld
domain. After a grant it is refused (the grant is history in `domain_lease_events`, by design); moving parties back
then means granting MASTER_DATA's holder PARTIES as well, not deleting rows.

## Known limits

- **Send again** (Sync health, admin) is gated on MASTER_DATA at the channel, as before. For a party, only a computer
  holding both MASTER_DATA and PARTIES can use it. PC1 holds both, so it can.
- **The backfill** still needs MASTER_DATA and the store lease. It marks parties only on a computer holding PARTIES.
  PC2's backfill was done before this change, so nothing is lost.
- Customers, suppliers and contractors are all added on PC1. PC2 picks from what PC1 sends.
