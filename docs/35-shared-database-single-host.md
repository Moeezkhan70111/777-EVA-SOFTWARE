# 35 — One shared database across the factory PCs (single host)

**Status: PLAN, NOT EXECUTED. Path C is NOT ready for use.** Nothing in this runbook has been
carried out. Every step that touches the live data folder, Windows settings or the firewall needs
the owner to authorize and run it. Written 2026-10-21.

**Decision taken 2026-10-21:** path **C now, B incrementally**, and **per-machine number blocks
are kept**.

**One thing has been executed: a disposable packaged-build test (§9).** It was run against a
throwaway folder and proves exactly one technical fact — that a packaged 0.3.1 honors
`ERP_DATA_DIR`. It **does not authorize** transferring production data, enabling Remote Desktop,
installing, deploying, or beginning path C. Each of those remains a separate owner decision.

`C:\777-ERP-ERP-DIR-TEST` is the disposable test directory from §9. It is **not** a candidate
production data root and must never be used as one.

---

## 1. What this gives you, stated honestly

One machine holds **the one authoritative database**. The other PCs do not hold a copy and do not
synchronize — they open a remote session onto the host and drive the same application against the
same file. There is one `erp.local.sqlite`, so there is nothing to reconcile.

**It genuinely solves:** divergent databases, duplicate document numbers, master data that exists
on one PC and not another, "which machine has the real stock figure", and the device-identity
duplication problem (see §6).

**It genuinely does not solve:** concurrent operators. See §2, which is the real cost.

---

## 2. The hard limit — one operator at a time

Verified on the intended host:

| Fact | Value |
|---|---|
| Edition | Microsoft Windows 11 Pro Education |
| Version | 10.0.26200 (build 26200) |
| InstallationType | **Client** |
| Domain | WORKGROUP (not domain-joined) |

A **client** edition of Windows permits **one interactive session at a time**. When a second
person connects, the first is disconnected — their session keeps running, but they lose the
screen until they connect again.

So with path C, **one person uses the ERP at any moment.** Three stations cannot scan
simultaneously. If production scanning, gatepass and billing must happen at the same time, path C
alone is not enough and path B (or a Windows Server edition with Remote Desktop Services
licensing) is required.

This was stated before the decision and is repeated here so it is not discovered on the floor.

---

## 3. Remote Desktop is currently OFF

Verified current state on the host — **nothing was changed**:

```
fDenyTSConnections : 1        -> RDP DISABLED
UserAuthentication : 1        -> NLA required (good, keep it)
TermService        : Stopped / Manual
Firewall "Remote Desktop - User Mode (TCP-In)" : Enabled = False
Firewall "Remote Desktop - User Mode (UDP-In)" : Enabled = False
Firewall "Remote Desktop - Shadow (TCP-In)"    : Enabled = False
```

Turning it on is a deliberate security change to the machine holding the business data. It needs
the owner's explicit authorization, and the host should be on the factory LAN only — never port
-forwarded to the internet.

---

## 4. The step that is easy to get wrong

**Every Windows user account gets its own `%LOCALAPPDATA%`.** If two people sign in to the host
under different Windows accounts, each one opens a *different, empty* database and you are back
to the problem you are trying to escape — silently, with no warning on screen.

The application already has the fix. Verified in the code:

- `apps/desktop/src/main.ts:48` reads `process.env.ERP_DATA_DIR` **unconditionally** — packaged or
  not.
- `resolveRuntimePaths` (`apps/desktop/src/main/runtimePaths.ts:156-159`) prefers that override
  over the `%LOCALAPPDATA%\777-erp` default.
- `assertDevelopmentDataDir` returns immediately when `isPackaged === true`, so a packaged install
  is free to use the override.

So set `ERP_DATA_DIR` **machine-wide** (a System variable, not a User variable) to a fixed folder
outside any user profile, for example `C:\777-ERP-Data`. Then every account on the host opens the
same database.

**Do not skip this.** Without it, path C only works if all three people share one Windows login.

---

## 5. Why a network share is NOT an option

The obvious-looking alternative — keep the app installed on all three PCs and point every
`ERP_DATA_DIR` at `\\HOST\777-ERP-Data` — **must not be used.**

The database runs in WAL mode (`packages/data/src/sqliteDatabase.ts:196`,
`PRAGMA journal_mode = WAL;`). WAL requires a shared-memory `-shm` file, and SQLite's own
documentation states that WAL does not work over network filesystems. On SMB this fails or
corrupts rather than degrading gracefully.

*This point is from upstream SQLite documentation and the code's journal mode; it was not tested
here, and it should not be tested on real data.*

---

## 6. One advantage worth naming

`device-identity.json` lives in the data folder, and `apps/desktop/src/main/deviceIdentity.ts:21`
records a known limitation: copying the data folder to another PC copies the identity too, and
both machines then claim to be the same workstation. Duplicate-device detection does not yet
exist.

Path C **sidesteps this entirely** — there is one data folder on one host, so there is one
identity and no duplication to detect. That problem returns only when path B begins.

---

## 7. Runbook — for the owner to execute

Each step is listed with what it changes. Steps 3 and 4 touch production data and are **not** to
be run by Claude. Steps 1 and 2 are prerequisites: **if either is skipped, the transfer is not
authorized to proceed.**

**1. Verify the backup against known values — recording a hash proves nothing on its own.**

Two backups exist. The verified SQLite backup is:

```
C:\Users\Moeez Khan\AppData\Local\777-erp\backups\erp-backup-2026-10-20T17-40-21-854Z.sqlite
```

| Property | Expected value |
|---|---|
| Size | `15,278,080` bytes |
| SHA-256 | `3968A6A9B375D2525F41B5C2F8571EBCDC4FC7FB7DB00DCA1F1FFE034DC3E72D` |
| `PRAGMA integrity_check` | exactly `ok` |

All three must match **exactly**. Run the integrity check against an authorized copy of that
backup, opened **read-only**. **Do not open or query the production database to perform this
check** — the backup file stands on its own, and nothing here requires reading
`erp.local.sqlite`.

If the size differs, the hash differs, or the integrity check returns anything other than `ok`:
**stop.** There is then no verified way back, and no later step may be attempted.

The second backup is the full-folder copy at `C:\777-ERP-PreInstall-Backup-2026-10-21`. Both are
referred to below as "the two verified backups".

*Context from file metadata only: this backup was taken at 17:40:21.854Z and the production
database's last write is 17:40:32Z — about ten seconds apart — so it reflects essentially the
current state. That was read from timestamps, not from the databases.*

**2. Record the business baseline from the paper books — BEFORE anything is moved.**

This is the step that decides whether the switch can be trusted, and it cannot be done
afterwards. Once the data root changes, "does this look right?" against memory is exactly the
judgement that a wrongly adopted database defeats, because that database also looks like a
working ERP.

So write down real values from the **current authoritative paper books** while they are still the
reference. Fill every placeholder with an actual identifier or figure:

| What | Record | Value |
|---|---|---|
| A recent gatepass | number, date, party, total quantity | `__________` |
| Recent production | totals for two named days | `__________` |
| A party | name/code and its ledger balance | `__________` |
| Stock | a named article + size, and its figure | `__________` |
| Most recent bill | voucher number, date, total | `__________` |

**No identifiers, dates or figures are supplied here on purpose.** Only the paper books are
authoritative, and inventing plausible-looking examples would be worse than leaving the table
blank — someone could check against them and believe they had passed.

**If this baseline has not been recorded, the transfer is not authorized to proceed.** Step 5
compares the application against *this written record*, never against recollection.

**3. Create the shared folder and copy the production dataset into it.** With the ERP **closed**
and no ERP process running.

*Before the copy:*

- **`C:\777-ERP-Data` must not already exist.** If it does, **stop.** Do not merge into it, do not
  overwrite it, do not rename it, do not delete it. Its presence means something is not as this
  document assumes, and that must be understood before anything is written.
- Read the source and destination paths **character for character**:
  - source `C:\Users\Moeez Khan\AppData\Local\777-erp`
  - destination `C:\777-ERP-Data`
- Confirm the destination is **not** the production data root, **not** either of the two verified
  backups from step 1, and **not** `C:\777-ERP-ERP-DIR-TEST` (the throwaway folder from §9).

*The copy itself:*

- **Copy. Never move.** The production folder must still be complete and usable afterwards.
- Copy `erp.local.sqlite` plus `product-images`, `delivery-proofs`, `backups`, `logs`, `session`
  and `device-identity.json`.
- **Overwrite nothing.** No existing database and no existing file may be replaced. Since the
  destination did not exist a moment ago, any overwrite prompt means the path is wrong — stop.

*After the copy, before the application ever opens it* — all read-only, ERP still closed:

- The destination `erp.local.sqlite` must match the source copy in **both size and SHA-256**.
- `PRAGMA integrity_check` on the destination must return exactly `ok`.
- The destination's migration version must match the expected source version. The expected
  ceiling is **83**, with `083_sync_outbox_transient_attempts` as the highest known migration
  (confirmed from the migration files shipped in the 0.3.1 build, §9 — not from reading the
  production database).
- The **two verified backups** and the **original production database** must be unchanged. Check
  filesystem metadata only — size and modification time. **Record production's size and mtime
  immediately before the copy and require them to be identical afterwards**; the figures move
  every time the ERP is used, so a value written down in this document goes stale. As of
  2026-10-21 23:11:55 production was `16,408,576` bytes with no `-wal` or `-shm` sidecars — that
  is the state the pre-cutover backup was taken from, not a value to compare against later.

**If a path is ambiguous, a file is present that should not be, or any verification differs:
stop. Do not attempt a repair.** The production data and both backups are intact at that point,
and that is the condition worth preserving.

> **First-launch legacy migration can silently adopt stale data even when `ERP_DATA_DIR` is set.
> This is the dangerous step, and it is why the dataset must be in place and validated before the
> application is ever started against a new data root.**
>
> Setting `ERP_DATA_DIR` controls *where* the application reads and writes. It does **not** mean
> the folder stays as you left it. On first launch against a data root with no
> `erp.local.sqlite`, `migrateLegacyData` looks for a legacy root and, if it finds one, copies
> that database in and migrates it forward — with no prompt and nothing on screen to say so.
>
> The legacy roots are `%TEMP%\erp-desktop-runtime` and `<appPath>\.runtime\electron`
> (`apps/desktop/src/main/runtimePaths.ts:175-178, 232-233`). Your production folder,
> `%LOCALAPPDATA%\777-erp`, is **not** among them — so the application will never fetch your real
> data for you, but it may well fetch somebody's old data instead.
>
> This was observed, not reasoned about (§9). Launching the packaged 0.3.1 against a brand-new
> empty folder produced `status: MIGRATED`, `copied: 6`, adopting
> `C:\Users\<you>\AppData\Local\Temp\erp-desktop-runtime` — a **September 2026 development
> database** — and migrating it to ceiling 83. The result opens as a plausible-looking working
> ERP carrying entirely wrong figures.
>
> Placing the validated production dataset in the folder first removes the possibility:
> `migrateLegacyData` returns `ALREADY_PRESENT` and never consults a legacy root at all, the
> moment `erp.local.sqlite` exists (`apps/desktop/src/main/runtimePaths.ts:266-268`).
>
> **Do not rename, delete or overwrite `%TEMP%\erp-desktop-runtime` on the strength of this
> document.** It is a live legacy root that the application still reads, it may be the only copy
> of data someone relies on, and other tooling may point at it. What depends on it and what would
> be needed to recover it have not been assessed. Removing it is a separate decision requiring its
> own review and authorization.

Grant the Windows accounts that will use the ERP modify permission on `C:\777-ERP-Data`.

**4. Set the machine-wide variable.** In an elevated PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('ERP_DATA_DIR', 'C:\777-ERP-Data', 'Machine')
```

Sign out and back in (or reboot) so the variable reaches newly launched processes.

**5. Compare the application against the step 2 baseline — not against memory.**

The failure mode in step 3 does not produce an empty screen. It produces a working-looking ERP
full of someone else's old data. So open the written baseline from step 2 and check each line of
it against what the application now shows:

- the recorded gatepass — number, date, party, total quantity;
- the recorded production totals for both named days;
- the recorded party and its ledger balance;
- the recorded article and size, and its stock figure;
- the recorded bill — voucher number, date, total.

Agreement on **every** recorded value is the pass condition. Disagreement on any one of them
means **stop and do not work in the application**. At that point the real data is still untouched
in the production folder and in the two verified backups from step 1.

If the baseline was never written down, there is nothing to compare against and the switch cannot
be validated. Go back to step 2.

> **On `data-migration.json`:** its absence is a weak secondary signal, not proof. The marker is
> written only when a legacy root was adopted, or when Local Data was reset
> (`apps/desktop/src/main/runtimePaths.ts:289-293, 324-328`). A genuinely correct copy leaves no
> marker — but so does a `FRESH_INSTALL` that opened an empty database. Absence therefore tells
> you only that *this particular* failure did not occur; it never tells you the right data loaded.
> Its **presence** on a root you populated yourself is a real warning sign worth investigating,
> but the record comparison above is what decides the question.

**6.** Leave the old `%LOCALAPPDATA%\777-erp` folder exactly where it is. Retiring it is a
separate decision for later, after the shared root has been in real use long enough to trust, and
it needs its own authorization. Never delete it.

**7. Enable Remote Desktop on the host** (owner's decision, §3), keep NLA on, enable the firewall
rules for the **Private** profile only, and give the host a static or reserved LAN IP.

**8. On each other PC**, use the built-in Remote Desktop Connection to the host. Do **not** install
the ERP on them — an installed copy there would create a second database, which is the whole
problem.

---

## 8. What path B means now

With C in place, all three factory PCs are already on one database, so **B is no longer needed to
make those PCs agree.** Its remaining purpose is different and should be judged on its own merits:

- a second site or a genuinely disconnected machine,
- an off-site continuously updated replica for disaster recovery,
- removing the one-operator-at-a-time limit from §2.

If B is wanted for the third reason, note that it is the hardest version of B: it needs every
domain, not just the append-only ones.

**Where B already stands:** two aggregate types (`QR_MASTER`, `PRODUCTION_PRODUCED`) have a cloud
contract, out of 117 tables; only `packages/data/src/database/production.ts` enqueues anything;
`applyEnvelope` permanently refuses every other aggregate type. Two-client convergence is proven
for those two types against the in-process test backend, not against a real cloud.

Each further domain needs a business decision before it can be coded: **what wins when two
computers have both changed the same record?** That question has no technical default for
ledgers, bills or stock corrections.

**Numbering:** per-machine blocks (1–5, 100,000 apart) are kept, as decided. That is consistent
with both C and an offline-first B. Under C there is one installation, so one block is in use.

---

## 9. Evidence — the ERP_DATA_DIR test (2026-10-21, executed)

The packaged build was launched **once** against a disposable folder, `C:\777-ERP-ERP-DIR-TEST`,
with `ERP_DATA_DIR` set in the **child process environment only** — no user, machine or
persistent variable was changed. The production SQLite database was never opened, queried, copied
or modified; only its filesystem metadata was read.

| Check | Result |
|---|---|
| Executable SHA-256 | `5A72…DBD0`, exact 64-character match |
| Embedded provenance | `v0.3.1 · a4eec1c41a1e · migrations<=83 · built 2026-10-20T19:42:03.086Z`, `"dirty": false` |
| Effective data root | `C:\777-ERP-ERP-DIR-TEST` — **the override was honored** |
| Fallback to production | none |
| Empty target directory | did **not** yield an empty ERP |
| Startup status | `MIGRATED`, `copied: 6`, from `%TEMP%\erp-desktop-runtime` — see §7 step 3 |
| Adopted data | a stale September 2026 development database (1 party, 23 production events, 8 QR codes) |
| Migrations | ran **inside the disposable folder only**, reaching ceiling 83; `integrity_check` = ok |
| Device identity | `MINTED`, new workstation, `enrolled: false`, `secureStorage: true` |
| Shutdown | clean, exit code 0 |
| Windows security | no block, no prompt |
| Production database | not opened; metadata unchanged — 16,134,144 bytes, mtime 2026-10-20 22:40:32, no WAL/SHM sidecars |

**What this establishes:** one fact — a packaged 0.3.1 honors `ERP_DATA_DIR`, so the mechanism
§4 and §7 step 4 depend on does work.

**What it does not establish:** that path C is ready, that the data transfer in §7 step 3 is
safe to perform, or that anything may be installed, deployed, or switched on. It is a single
launch against throwaway data on one machine.

Its more valuable result was negative: it disproved an earlier written claim that an empty data
root would simply yield an empty ERP. §7 step 3 now records what actually happens.

`%TEMP%\erp-desktop-runtime` was **read from by the application but not altered, renamed or
removed**, and must not be, pending the separate assessment described in §7 step 3. The
disposable folder `C:\777-ERP-ERP-DIR-TEST` is preserved unaltered for review, holds no real
business data, and is not a candidate production data root.

---

## 10. Still open

- **Production launch of 0.3.1 is stopped at preflight.** The hash question is now **resolved** —
  the executable is `5A724DC170ADE042EC9A5147BE17F31CB155F8C02B719D2FB379F3B66AD9DBD0`, verified
  above. The launch itself still awaits the owner's go-ahead.
- The release candidate `777 ERP Setup 0.3.1.exe` remains **unsigned** (see `docs/25`, `docs/25a`).
- Whether the other two PCs can reach this host over the factory LAN has not been tested.
