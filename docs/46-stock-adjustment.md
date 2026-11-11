# 46 — Stock Adjustment: Opening Stock and carton corrections

A dedicated page, **Stock Adjustment** (Inventory → Stock Adjustment), for an administrator on the computer that holds
the **CARTON_STOCK** lease (PC1). It is separate from Manual Production, which records daily production and is not used
or changed here.

## What it does

| Mode | What a line does | Rule |
|---|---|---|
| Opening Stock | adds cartons (`CARTON_ADJUST_IN`) | once per colour and size: a second opening is refused, whole document |
| Stock Adjustment | adds (`CARTON_ADJUST_IN`) or takes out (`CARTON_ADJUST_OUT`) | never takes the figure below zero |

A document has a number in this computer's range (`SA-000001`), a transaction date, a reason, optional remarks, who
posted it and the workstation. Lines are chosen by article and colour, with a quantity per size, and several
article/colour combinations may go on one document. Before posting, each line shows the figure in store now and the
figure it will leave. Post asks first, then posts **all lines or none**, in one transaction. A posted document is never
changed: a mistake is corrected by another document. There are no drafts: a document is posted or it does not exist.

## How it is stored (local migration 107)

- `carton_stock_adjustments`: the document. `carton_stock_adjustment_lines`: its lines, each naming the movement it made.
- Each line is one movement on `carton_stock_events` through the one writer (`recordCartonStockMovement`), so the
  figure, its never-below-zero rule and its reconciliation are exactly those of every other carton movement. The
  movement's reason starts with the document number and kind, so another computer's history says what it was even
  before the document arrives.
- The screen's request id is the document id: a Post retried after a lost answer adds nothing.

## How it travels

- **Movements**: `CARTON_STOCK_EVENT`, as before (cloud 027 already accepts the two adjustment types).
- **The document**: a leased record `CARTON_STOCK_ADJUSTMENT` under the carton lease (**cloud 030**, rows only).
  Until 030 is applied, the document waits as `UNKNOWN_RECORD_TYPE` and the movements still travel; once it is, the
  document follows. 030 is **prepared, not applied**: TEST first, then production in the SQL editor, like 029.
- Only the CARTON_STOCK holder may post (the lease guard refuses elsewhere; the page says so and shows history only).
  Nothing here asks for, or writes under, RAW_MATERIAL_STORE.

## Carton Cloud protection

The document type counts as stock (`STOCK_RECORD_TYPES`): the backfill never marks it, and Send Again refuses it while
Carton Cloud is off. It is **not** added to the activation cutoff tables — that would make every existing activation
invalid (its seal covers the table list). Instead a document is local exactly when one of its movements is, so a
document made before activation, or on a computer where Carton Cloud is off, never leaves.

## Release sequence

1. Release the version carrying local 107 to PC1, PC2 and PC3 (the outbox learns the new type).
2. Apply cloud 030 to TEST, check, then production.
3. Post Opening Stock on PC1.
