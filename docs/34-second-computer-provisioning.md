# Provisioning a second computer for the sync pilot

What a second 777 ERP installation needs before it can scan production and exchange it with the
first. Every step is deliberate: nothing here is worked out by the application, because nothing on
a computer can verify a factory-wide decision on its own.

**Scope of the pilot.** Carton identities (`QR_MASTER`) and production scans
(`PRODUCTION_PRODUCED`) only. Billing, gatepasses, dispatch, returns, store movements, cash,
parties, raw materials and machine programs stay local on each machine and do **not** synchronise.
Stock is never carried as a value; a receiving computer recomputes it from the events it is given.

---

## Before you start

- The **first** computer keeps document-number range **1**. Never give range 1 to a second machine.
- Decide and **write down** which machine holds which range (2, 3, 4 or 5). The application cannot
  check this for you — the only protections are this written record, the out-of-range check, and
  the UNIQUE constraints that turn a collision into a refused save.
- QR **generation** stays on the one designated workstation. Carton serials come from per-article
  counters that are not covered by the range scheme, so two machines generating labels can issue
  the same serial. Every other machine can scan, produce, store, dispatch and return.
- **Verify the clock before enrolling.** A replicated row keeps the time the origin PC wrote, so a
  wrong clock writes wrong business times, and a badly wrong one breaks TLS to the cloud. On
  2026-10-23 a newly moved PC was 22h 42m slow and on Pacific time. All three must pass:
  1. `tzutil /g` prints `Pakistan Standard Time`.
  2. `w32tm /query /status` shows a real `Source` and a `Last Successful Sync Time` from today,
     not `Leap Indicator: 3(not synchronized)`. Fix it with `w32tm /resync /force` in an admin
     shell.
  3. `(Get-Date).ToUniversalTime()` is within a minute of the `Date` header from
     `curl -sI https://<project-ref>.supabase.co`.

  Why, and what the arrival-time column records: `docs/37 §0.3`.

---

## 1. Cloud: the factory row (once per project, not per computer)

```sql
insert into factories (id, code, name, timezone, is_active, created_at, updated_at)
values ('factory-777', '777', '777 Manufacturing', 'Asia/Karachi', true, now(), now())
on conflict (id) do nothing;
```

The id must be exactly `factory-777` — that is what every installation already uses.

## 2. Cloud: an Auth user for the computer

Authentication → Users → Add user. **One account per computer, not per person.** Record the email;
the password is needed once, on this machine's first sync, and not afterwards (step 7).

Never put the `service_role` key anywhere near the application: it bypasses every policy. The app
refuses a key whose payload names that role.

## 3. Cloud: enrol the device account

```sql
insert into device_accounts (auth_user_id, factory_id, workstation_id, device_id, label, is_active, enrolled_at)
values ('<auth user uuid>', 'factory-777', '<workstation id>', '<device id>', '<where it stands>', true, now());
```

`device_id` and `workstation_id` must match the values in the computer's own
`device-identity.json` (step 5) **exactly**. An account with either column null is refused
`BINDING_INCOMPLETE` by `claim_device` and can write nothing — that is deliberate.

Migration 006 also adds a composite foreign key, so `device_accounts(workstation_id, device_id)`
must match a real `workstations(id, device_id)` row. Create the workstation first (step 4).

## 4. Cloud: the workstation, operators and product variants

None of this synchronises. A computer that meets a carton naming a product it has not been given
refuses it visibly rather than inventing one.

- `workstations` — the row this machine records its scans as, including its `device_id`.
- `operators` — every operator this machine will name in a scan. An unknown operator is refused
  per row (`UNKNOWN_OPERATOR`), not silently accepted.
- `product_variants` — every variant whose cartons this machine will push. An unknown variant is
  refused per row (`UNKNOWN_PRODUCT_VARIANT`).

## 5. Local: the computer's identity

Its `device-identity.json` in the data root fixes `factoryId`, `workstationId`, `workstationCode`,
`deviceId` and `deviceName`. On a fresh installation the app mints these once and then keeps them;
`workstations.workstation_code` is UNIQUE, so two machines must not share a code.

Check the startup log line `operation: "device-identity"`. It reports the five facts that matter,
and `secureStorage: true` means this machine can hold an encrypted credential.

## 6. Local: the document-number range

**Settings → Document Number Range.**

- The computer holding the existing documents presses **adopt**, which records range 1 after
  proving from its own data that it is that machine.
- A **second** computer is assigned a range from **2 to 5**, typed by an administrator from the
  written record. Blocks are 100,000 apart: 2 → 100,000-199,999, 3 → 200,000-299,999, and so on.

Refused, and stated plainly, when: the range is outside 2-5; it is range 1 (that one belongs to the
existing-data machine); a range is already recorded here (a range is never reassigned); or this
machine already holds documents that would not fit the range being recorded.

**Until this is done, no numbered document can be created on the machine** — no product, no party,
no gatepass. Scanning and production are unaffected.

## 7. Local: the cloud credential

Set four environment variables in the session that starts the app:

```
ERP_SUPABASE_URL        https://<project-ref>.supabase.co
ERP_SUPABASE_ANON_KEY   the publishable (anon) key
ERP_DEVICE_EMAIL        this computer's device account
ERP_DEVICE_PASSWORD     its password
```

On the **first** successful sync the refresh token is stored, encrypted against this Windows user
by `safeStorage`, in `device-credential.bin` in the data root. From then on **the email and
password are no longer needed**: the URL and anon key still are, because they say which project
this is. The log records `operation: "device-credential"` the first time one is stored.

- Resetting the local data does **not** remove the credential: clearing a test database must not
  turn a computer into a different computer.
- A refused request does not remove it either; only a deliberate re-enrolment does.
- A copied data folder cannot use it — that is the point of encrypting it against the machine.

## 8. Apply the cloud migrations, in order, once per project

`002 → 003 → 004 → 005 → 006`, pasted whole into the SQL editor.

**Never run 003 again after 005.** It would reinstate a trigger body that omits `factory_id`, and
the next production scan would then fail the check constraint — scans refused by the database, with
nothing in the error pointing at 003. Detector:

```sql
select position('origin_device_id, factory_id' in prosrc) > 0 as is_005_body
from pg_proc where proname = 'log_production_produced_insert';
```

`true` is correct. If it is ever `false`, re-apply 005 before the next scan.

---

## Verifying the pilot

On the second computer: **Settings → Cloud Sync** must show the right project host, then one
**Sync Now**.

| What to read | Means |
|---|---|
| `sent N` | N events this machine delivered. 0 means nothing left it |
| `read / applied / already here` | the pull: what arrived, what was written, what was already here |
| `refused N` | events this machine cannot apply, each with a reason |
| the queue's **not sendable yet** count | events with no transport — see below |

`sent 1` alone does not prove an insert: a repeat is accepted as `DUPLICATE` and counted the same.
The cloud-side proof is the row itself plus a new `sync_event_log` entry, which only the insert
trigger can create.

## What stays in the queue, and why that is not a fault

Dispatch, returns, store movements, damage and adjustments are still enqueued locally and have **no
transport**. They are never claimed, so they are never offered, refused, retried or parked — they
wait as `PENDING`, and the Cloud Sync panel counts them under **not sendable yet**.

Nothing discards them. That number growing is expected during the pilot and is the honest measure
of how much of the ERP does not yet synchronise. Watch it: it is also the first place a forgotten
contract will show up.

## If something is refused

| Reason | What it means | What to do |
|---|---|---|
| `NOT_ENROLLED` | no `device_accounts` row for this account | step 3 |
| `BINDING_INCOMPLETE` | the row has no `device_id` or `workstation_id` | step 3 |
| `DEVICE_MISMATCH` / `WORKSTATION_MISMATCH` | the identity file and the enrolment disagree | compare steps 3 and 5 |
| `CLAIM_SUPERSEDED` | another computer claimed this same enrolment | give each machine its own account |
| `REVOKED` | the account is inactive or revoked | the owner re-enables it |
| `UNKNOWN_PRODUCT_VARIANT` / `UNKNOWN_OPERATOR` | master data this project has not been given | step 4 |
| `QR_NOT_REGISTERED_YET` | the carton has not arrived yet | nothing: it waits and goes again |
| `NOT_CONFIGURED` from a numbered document | no document-number range here | step 6 |

A claim refusal stops the pass and touches nothing in the queue. A per-row refusal is bounded: five
attempts and the event is parked in the dead-letter queue, where an administrator can put one back
by name. `QR_NOT_REGISTERED_YET` is the exception — it waits without limit, because it is a
prerequisite rather than a verdict.
