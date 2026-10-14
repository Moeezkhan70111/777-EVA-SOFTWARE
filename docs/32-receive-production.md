# Receive Production — Phase 2

> Built 2026-10-14. No migration. The QR Generator's third tab: scan a generated carton QR and it is
> recorded as produced, exactly once. Store Move In/Out and later phases are not part of this.

## Where it is

QR Generator → `[ Carton QR ] [ B-Carton Labels ] [ Receive Production ]`. The Machine Program stays
its own page (Phase 1.1); the tab is offered only to users with the **Live Production** permission —
production is production, whichever screen records it — and the main process checks that permission
again on every call. The tab asks for no machine: a carton's QR already belongs to its program.

## One path for scanner and keyboard

```
scanner burst / typed code + Enter / Enter button
  → useScanBox (features/scanStation, one at a time)
  → api.receiveProduction(code)            IPC erp:receive-production   (LIVE_PRODUCTION)
  → ReceiveProductionUseCase               @erp/application
  → recordProductionInTransaction          the ONE production step (Live Production and Carton In use it too)
```

`useScanBox` gained an opt-in `autoSubmit: "scanner-burst"` mode: a code that arrives at scanner speed
goes on its own; one typed by hand (a gap of more than 60 ms between characters) waits for Enter or
the button, and if it is refused it is put back in the box for correcting. Every other station keeps
the old behaviour (the default mode is unchanged). `ScanPanel` gained an optional Enter button.

Fixed on the way, for every station: an auto-submit timer armed by an effect left over from an
earlier render could fire after the code had already been sent, sending it twice (seen under load as
`[1,1,2,2,3,3]`). The timer now submits only if the box still holds the value it was armed for.

## What is checked, in the main process

| Outcome | When | Written |
|---|---|---|
| `RAW_MATERIAL_QR` | the value is a raw material label (`RM_…` / `RMQR_…`) | nothing |
| `INVALID_QR` | empty, or not a carton QR (`parseQrCode` refuses) | nothing |
| `ALREADY_RECEIVED` | a `qr_master` row exists — produced here, at Live Production or at Store In | nothing |
| `NOT_GENERATED` | no `qr_codes` row — the generator never issued it. **Never adopted** (Live Production still adopts, by the owner's 2026-10-13 rule) | nothing |
| `INELIGIBLE` | the code is `VOID` in QR Management (or replaced by a B label), or its product is gone | nothing |
| `RECEIVED` | otherwise | `qr_master` (PRODUCED), the PRODUCED event, the stock projection, the outbox — one transaction |
| `ERROR` | anything else | nothing (the transaction rolls back) |

The receiving user and station go into the PRODUCED event's `metadata_json` (`actor`, `station =
RECEIVE_PRODUCTION`) — `operator_id` references the `operators` table, which app users are not in.

## Exactly once

* Eligibility is read and the receipt written inside one `BEGIN IMMEDIATE`.
* `qr_master.qr_id` is the PRIMARY KEY: a second unit for one carton cannot be written by any route
  (a collision is reported as `ALREADY_RECEIVED`).
* The use case runs receipts **one at a time**. This is needed: `SqliteDatabase.runInTransaction`
  has no queue of its own, and two overlapping calls on the one connection make both fail and can
  leave the first one's writes outside its transaction (proved with a probe during Phase 2). In the
  app today IPC calls cannot overlap inside a transaction — every repository call is synchronous —
  but the shared transaction manager should get its own queue (follow-up, not done here).
* The screen sends one scan at a time and never shows RECEIVED before the main process says so.
* If the call itself fails, the screen asks `erp:find-production-receipt` whether the carton is
  produced and shows that — it never retries blindly (and a retry could not double-receive anyway).

## The activity panel

`erp:list-production-receipts` — today's (Asia/Karachi) PRODUCED events, newest first, 25 to a page,
with the day's total cartons and dozens (`cartonsToDozens`). Product, grade, machine program and the
carton's current stage are read through the registry. Reloaded after each scan this screen makes and
polled every 5 s while the window is visible, so receipts from another station appear on their own;
a failed refresh keeps the last list and says it is not updating. Nothing is added on screen ahead of
the database, so no row can appear twice.

`businessDayStartIso` (@erp/domain) gives the UTC window of a Karachi business day regardless of the
computer's own timezone. (`localDayStartIso`, used by the Store daily report and QR Management, uses
the computer's zone — the same on a Pakistan-time PC, different elsewhere.)
