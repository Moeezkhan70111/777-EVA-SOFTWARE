# 51 — Parties on their own lease, held by the store computer

Owner's request, 16 Nov 2026: give PC2's store operator the ability to add a new party. Owner's decision: **Option C**,
a dedicated lease for parties, held by PC2. PC1 keeps MASTER_DATA for everything else.

## The rule now

| Lease | Holder | Writes |
|---|---|---|
| MASTER_DATA | PC1 (office) | products and their grouping, article sizes, machines, work sections, colours |
| **PARTIES** (new) | **PC2 (store)** | **parties and party groups** |
| RAW_MATERIAL_STORE | PC2 (store) | units, ladders, categories, materials, their stock, labels and packets |

Every computer still reads every party: PC1 and PC3 receive PC2's parties and party groups as before. A computer
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
holder of PARTIES must not write a party until it has pulled all of them (011's catch-up rule). The barrier makes PC2
refuse its own party writes, showing "catching up", until its pull passes PC1's last party revision.

## Safety

- **Retries and duplicates:** a party revision is idempotent in the cloud (013: same revision and body = DUPLICATE),
  and a second delivery to a receiver is ignored (tested).
- **Offline:** PC2 writes parties offline as the PARTIES holder; they queue with the PARTIES epoch and go when it
  reconnects. Nothing else changes.
- **Conflicts:** one writer. A party written on a computer without PARTIES is refused locally by the write gate, and,
  if it was written on an old release, refused by the cloud NOT_LEASE_HOLDER and parked in that computer's dead
  letters. It never reaches another computer (tested).
- **Stale holder:** if PARTIES moves away from PC2, PC2's later party writes are refused by epoch (tested).
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
4. **Grant PARTIES to PC2** (production, owner only, the established procedure of docs/36 7.6 and 011):

   ```sql
   select public.grant_domain_lease(
     'PARTIES',
     '47c0dace-fe68-42cb-989c-e94f69c62c0f',   -- PC2, DESKTOP-R1V8 (read 7 Nov 2026: confirm before running)
     'PC2 store'
   );
   ```

   Confirm PC2's device id first:

   ```sql
   select device_id, device_name, is_active, revoked_at, workstation_id from public.device_accounts where device_name ilike '%R1V8%';
   ```

   Expected answer: `{"accepted": true, "epoch": 1, "barrierSeq": <the last party seq>, "tookOverFrom": null}`.
5. **On PC2**, sync once. Party List and Party Form stop showing read-only once PC2 has pulled past the barrier.
6. **Permission**: an administrator gives the store operator's account **Party Form** (Users → the operator →
   screens/extras) if it does not have it. Party List (`party-list`) lets them see the list too.

**Rollback:** before step 4, `035_parties_lease.down.sql` returns both types to MASTER_DATA and removes the unheld
domain. After a grant it is refused (the grant is history in `domain_lease_events`, by design); moving parties back
then means granting MASTER_DATA's holder PARTIES as well, not deleting rows.

## Known limits

- **Send again** (Sync health, admin) is gated on MASTER_DATA at the channel, as before. For a party, only a computer
  holding both MASTER_DATA and PARTIES can use it. Re-sending a party from PC2 needs that gate made per record type.
  The data layer already picks the right lease.
- **The backfill** still needs MASTER_DATA and the store lease. It marks parties only on a computer holding PARTIES.
  PC2's backfill was done before this change, so nothing is lost.
- Customers are parties: after the grant, **customers are added on PC2 too** (owner's choice, Option C).
