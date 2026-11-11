# 47 — Who writes raw-material master data

## The problem

One lease, MASTER_DATA, covered both general master data and the raw-material taxonomy. When MASTER_DATA moved to PC1
(epoch 4), PC2 — which holds RAW_MATERIAL_STORE and every real raw material — could no longer add a material: the
write guard required MASTER_DATA for `createInventoryItem` and every other raw-material setup channel, and the cloud's
`leased_record_types` named MASTER_DATA for INVENTORY_ITEM, INVENTORY_CATEGORY, INVENTORY_UNIT and UNIT_LADDER_PRESET.

## The rule now

| Lease | Holder | Writes |
|---|---|---|
| MASTER_DATA | PC1 | party groups, parties, work sections, machines, products and their grouping, colours |
| RAW_MATERIAL_STORE | PC2 | units, unit ladder presets, categories, materials — and their stock, label runs and packets |

One writer for a material and its stock. Creating a material with opening stock, importing materials, removing one for
good, correcting its unit and approving a removal are now one lease, the store's (they needed both before).

## What changed

- **Cloud 031** (rows only): `leased_record_types.lease_domain` for the four types becomes RAW_MATERIAL_STORE.
  `push_leased_record` reads it on every push. Records already stored keep their rows; the next revision is accepted
  from the store holder at its epoch (013 compares revisions, not epochs).
- **App**: the four types map to RAW_MATERIAL_STORE (`LEASED_AGGREGATE_DOMAIN`), so capture marks and queued revisions
  carry the store's epoch (the capture triggers are rebuilt at every start). The raw-material IPC channels are leased
  to the store. The Raw Material screens' notices ask for the store's lease; the machines panel still asks for MASTER_DATA.
- **Repair A** asks for the lease materials are written under, so it now runs on PC2 with RAW_MATERIAL_STORE alone.
- Receiving is unchanged: a computer applies a record whoever wrote it.

## Release order

1. Apply cloud 031 to TEST, then production (`select aggregate_type, lease_domain from public.leased_record_types
   order by 1;` before and after).
2. Install the release on PC2, then PC1 and PC3.

A computer still on an older release stamps a material MASTER_DATA: after 031 the cloud refuses it NOT_LEASE_HOLDER,
visibly, in that computer's dead letters. Reading is unaffected everywhere. A supplier party is still general master
data: PC2 cannot add one unless that rule is changed too.
