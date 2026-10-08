# CLAUDE.md Compliance Audit — 777 ERP

**Date:** 2026-09-18
**Scope:** whole repository (`apps/desktop`, `packages/*`, `migrations`, `supabase`, `docs`)
**Baseline before refactor:** build PASS · `@erp/data` 96/102 tests · renderer 111/147 tests (36 pre-existing failures, mostly pages hidden by `visibleSections.ts`)
**Second pass (critical remediation, same day):** see §4 — `@erp/data` 95/101, renderer+main 121/156 (same pre-existing failures), build blocked only by an external in-flight edit (§4.2.5).

This audit records how the existing implementation measures against every rule in `CLAUDE.md`, before the compliance refactor. Findings are classified CRITICAL / HIGH / MEDIUM / LOW. Items marked **[fixed]** were addressed in the compliance pass; items marked **[decision]** need a business decision before they can be changed safely.

---

## 0. What the codebase actually is

`CLAUDE.md` is written against a generic web stack (RTK Query, Redux, React Hook Form, Zod, Tailwind-style tokens, `NEXT_PUBLIC_*`). The real 777 ERP is:

```text
Electron main process  (apps/desktop/src/main.ts)         ← owns SQLite, registers ~170 IPC handlers
        ↑ contextBridge (apps/desktop/src/preload.cts)     ← the only path renderer → main
React 19 renderer       (apps/desktop/src/renderer)        ← pages call window.desktop.api via useDesktopApi()
@erp/application        ← port-based use cases (scan / dispatch / return / store / gatepass)
@erp/domain             ← QR parser, pricing rule, party types
@erp/data               ← SqliteDatabase (7,600 lines) implementing the application ports
@erp/sync               ← OutboxSyncService stub (not wired)
@erp/scanner            ← ScannerFrameAssembler (not wired)
```

There is **no Redux, no RTK Query, no React Hook Form, no Zod, no Tailwind, no HTTP client**. The application is already offline-first: every read and write goes to the local SQLite file; `sync_outbox` rows are queued for a future cloud sync.

**Mapping of CLAUDE.md concepts to this project's equivalents** (used throughout this audit):

| CLAUDE.md says | 777 ERP equivalent |
|---|---|
| RTK Query / API layer | `useDesktopApi()` → preload → IPC channel → main handler → `SqliteDatabase` |
| `src/services/api/endpoints.ts` | `apps/desktop/src/shared/ipcChannels.ts` (created in this pass) |
| `USE_MOCKS` seam | `@erp/application` ports; `SqliteDatabase` is the local implementation, `@erp/sync` is the cloud seam |
| Redux slice for session | React context (`NotificationsContext` pattern) → `SessionContext` |
| Zod at external boundary | manual narrowing in IPC handlers; the only external boundary today is the renderer→main IPC input |
| Design tokens `bg-primary` | CSS custom properties in `styles/theme.css` (`--primary-blue`, `--text`, `--ok`, …) |
| `formatMoney()` | `renderer/app/format.ts` `money()` |

Introducing Redux/RTK Query/RHF/Zod would be a second architecture and a rewrite of ~40 pages, which `CLAUDE.md` §2, §7 and R22 forbid. The compliance pass therefore strengthens the existing seams rather than replacing them.

---

## 1. Findings by rule

### R9 — Security
| Sev | Finding | Where |
|---|---|---|
| CRITICAL **[fixed]** | Session token and saved multi-account profiles (with tokens) persisted in `localStorage`. | `App.tsx` `AUTH_TOKEN_KEY`, `SAVED_PROFILES_KEY` |
| CRITICAL **[fixed]** | Mutating IPC handlers (create/update/delete product, party, sale/cash/purchase vouchers, discounts, barcode generation, `reset-database`, `save-settings`, scans) accept **no session** — UI permission checks were the only gate. | `main.ts` `registerIpcHandlers` |
| HIGH **[fixed]** | Discount resolver writes 20 `console.log` lines with party/rule/price data on every resolution. | `sqliteDatabase.ts` `resolveDiscount` |
| HIGH **[fixed]** | Print windows interpolate product/party text into HTML without escaping (`DailyDispatchPage`, `DailyProductionPage`, `ProductionHistoryPage`, `StockPage`, `DiscountPolicyPage`). | pages |
| MEDIUM | Sale-voucher line `discount` total is accepted from the UI, while `discount_per_pair`/`discount_source` are resolved again in the backend → the two can disagree. Backend resolution should be authoritative. | `sqliteDatabase.addVoucherLineItem` **[decision]** |
| LOW | `LiveReturnPage` logs full scan results to console. **[fixed]** | |
| OK | `contextIsolation: true`, `nodeIntegration: false`, preload is the only bridge. Passwords are never logged. | `main.ts createWindow` |

### R10 — Strict TypeScript
| Sev | Finding |
|---|---|
| HIGH **[fixed]** | 16 `any` in production code (`main.ts` ×6, `sqliteDatabase.ts` ×8, `listPartiesUseCase.ts`, `updatePartyUseCase.ts`). |
| HIGH **[fixed]** | `main.ts` re-declares a 330-line hand-written `DesktopServices["db"]` interface and casts `db as unknown as …` instead of using the real `SqliteDatabase` type. |
| MEDIUM | Stray build artefacts committed as source: `packages/domain/src/index.d.ts`, `qr.d.ts` (stale, export only `qr`). **[fixed]** |
| LOW | Test files use `as any` for fixture access (acceptable in tests, left as-is). |

### R4 — Centralized API endpoints
| Sev | Finding |
|---|---|
| HIGH **[fixed]** | 170 IPC channel strings duplicated verbatim in `main.ts` and `preload.cts`. One channel (`erp:list-unique-colors-by-article`) is exposed in preload and typed in `DesktopApi` but has **no handler** → would reject at runtime. |

### R5 / R6 — Offline-first flow and state
| Sev | Finding |
|---|---|
| OK | No page imports fake data; every page goes through `useDesktopApi()`. Local SQLite is the operational store; app works with cloud off. |
| MEDIUM | `@erp/sync` and `@erp/scanner` are built and tested but never consumed by the desktop app. Kept (they are the intended cloud/scanner seams). |
| MEDIUM **[fixed]** | Session/user state lives in `App.tsx` `useState` and is prop-drilled (`token`, `username`) — the project's equivalent of a Redux slice is a React context. |
| LOW | `App.tsx` runs five `setInterval` polls (3 s session, 5 s roles/notifications/members/access-requests/permission-requests) even when the data cannot change. |

### R2 / R11 — Simplicity and feature organisation
| Sev | Finding |
|---|---|
| HIGH **[partly fixed]** | `App.tsx` 2,753 lines: contains `AuthScreen`, `RookieScreen`, `ChangePasswordPage`, `ProfilePage`, `FloatingProfileMenu`, `MemberSection` (480 lines), `RolesSection` (345 lines), page titles, keyboard routing, session persistence and the route switch. Split into `features/auth`, `features/users`, `app/`. |
| HIGH | `sqliteDatabase.ts` 7,598 lines, one class for every module. Splitting is a large mechanical move with regression risk across 100+ tests; **deferred** (see §3). |
| HIGH | `main.ts` 2,938 lines of IPC handlers. Handler registration is now grouped and authorised centrally; splitting by feature deferred. |
| MEDIUM | Pages of 800–1,800 lines (`ProductListPage` 1,809, `QrManagementPage` 1,554, `StoreMoveOutPage` 1,118, …) each embedding their own CSS string and local helper components. |

### R1 — Reusable UI
| Sev | Finding |
|---|---|
| HIGH **[fixed]** | `escapeHtml` implemented 3× (`barcodeLabels`, `gatepassPrint`, `rateList`); logo-to-data-URL loader implemented 3×; `window.open + document.write` print pattern implemented 8×. |
| MEDIUM **[fixed]** | `parseQr` re-implemented in `LiveProductionPage`, `LiveDispatchPage`, `LiveReturnPage` with three *different* regexes, while `@erp/domain.parseQrCode` is the authoritative parser. |
| MEDIUM | Scan-result icons (`ScanIcon`/`CheckIcon`/`ErrorIcon`), colour swatch maps, loading/empty markup repeated across scanner pages. Shared `StateView` added; icon consolidation deferred. |

### R3 — Design tokens
| Sev | Finding |
|---|---|
| HIGH **[partly fixed]** | `theme.css` defines a token block but then uses 609 hex + 300 rgba literals; pages embed 600+ hex literals in inline styles (`LiveDispatchPage` 159, `SaleVoucherFormPage` 63, `LiveProductionPage` 56, …). Several pages define their *own* `--pro-*`/`--ink-*` token sets (a second design system per page). Token block extended; literal replacement done where pages were touched. |
| LOW | Neumorphic shadows in `.nav-top-btn` contradict `PROJECT_CONTEXT.md` §5 "do not use". Visual change — **[decision]**. |

### R12 — Loading / Empty / Error / Success
| Sev | Finding |
|---|---|
| MEDIUM **[partly fixed]** | Most list pages show Loading and Empty; several swallow errors into a notification only, with no retry (`DailyDispatchPage`, `DailyProductionPage`, `HistoryPage`, `DispatchHistoryPage`, `ReturnHistoryPage`, `CustomerBalancePage`). Shared `StateView` component added and applied to touched pages. |

### R13 / R14 / R15 / R16 — Business logic, constants, money, dates
| Sev | Finding |
|---|---|
| CRITICAL **[decision — §4.2.2, plan in docs/20]** | All monetary columns are `REAL` rupees (`unit_price`, `total_price`, `discount*`, `receipt_amount`, `payment_amount`, `total_amount`, `balance_limit`, `selling_price`). CLAUDE.md R15 requires integer paisa. Migrating live financial tables is a data migration of every voucher/ledger/cash record and needs owner sign-off. |
| HIGH **[fixed]** | Sale line arithmetic (`pairRate*12`, `dznQty*2`, `amount−discount`) duplicated in `SaleVoucherFormPage.calc`, `CustomerLedgerPage`, `sqliteDatabase.addVoucherLineItem`, `updateVoucherLineItem`, dispatch (`requiredDzn*12`). Centralised in `@erp/domain/money.ts` (`calculateSaleLine`, paisa-exact) and `@erp/domain/units.ts` (`PAIRS_PER_DOZEN`, `CARTONS_PER_DOZEN`). |
| HIGH **[decision — §4.2.1]** | `deleteSaleVoucher` physically **deletes `production_events` and `sync_outbox` rows** and reverts QR status — contradicts `docs/16` "production_events is immutable" and CLAUDE.md §9. Behaviour left unchanged; needs a business decision (compensating RETURNED events would be the auditable alternative). |
| HIGH **[fixed — §4.1.3]** | **Dispatch allowance unit conflict.** `getDispatchSession` reports `requiredPairs = dozens × 12` and `dispatchedPairs = number of DISPATCHED scans`; `checkDispatchSessionAllowance` blocks a scan only when scans ≥ dozens × 12. `LiveDispatchPage` treats one scan as one **carton** (`dozens × 2`) and shows "x of y scanned" on that basis. The backend therefore permits 6× more scans per dozen than the screen implies. Left unchanged (commented in code); the owner must confirm whether a QR is a pair or a carton for dispatch. |
| HIGH **[decision]** | SQL injection through `sortBy`: `listParties`, `listHistory`, `listDispatchHistory` interpolated a caller-supplied column into `ORDER BY`. **[fixed]** with a column whitelist in the data layer. |
| MEDIUM **[fixed]** | Operational day (06:00→06:00) constant hard-coded in `sqliteDatabase.getReport`, `DailyDispatchPage`, `DailyProductionPage`. Centralised as `OPERATIONAL_DAY_START_HOUR`. |
| MEDIUM **[partly fixed]** | Magic strings for statuses (`"IN_PROGRESS"`, `"CANCELLED"`, `"ADMIN"`, `"APPROVED"`, discount sources, QR stages) across renderer and data layer. Domain constants added and used in touched code. |
| MEDIUM **[fixed — §4.1.9]** | 130+ `toLocaleDateString()/toLocaleTimeString()` calls with no timezone across pages; `format.ts.toLocal` likewise. Central `renderer/utils/dates.ts` (Asia/Karachi) added and adopted in touched code. |
| LOW | `money()` formats with `en-US` locale and 2 decimals; PKR display convention not decided. |

### R7 / R19 — Mobile compatibility / responsive
| Sev | Finding |
|---|---|
| HIGH **[fixed]** | 8 direct `window.open("", "_blank")` + `document.write` sites. Routed through one `platform/print.ts` abstraction (`openPrintDocument`) so a native bridge can replace it later. |
| MEDIUM | Main window `minWidth: 960`. Pages carry their own `@media (max-width: 900px)` rules; several dense tables have no small-screen representation. Deferred (UI redesign out of scope). |

### R17 — Forms
| Sev | Finding |
|---|---|
| MEDIUM | Forms are hand-rolled `useState` + manual validation; validation messages are generally specific ("Please enter your username"). No RHF/Zod in the project; not installed (R22). Left as-is. |

### R18 — Accessibility
| Sev | Finding |
|---|---|
| MEDIUM **[partly fixed — §4.1.11]** | Icon-only buttons without `aria-label` in several pages; status conveyed by colour + text in scanner pages (OK). Shared components created in this pass are labelled; full audit of 40 pages deferred. |

### R20 — Performance
| Sev | Finding |
|---|---|
| HIGH | `main.ts` `erp:get-item-status` loads `listDispatchHistory({ pageSize: 10000 })` and scans it in JS. **[fixed]** — replaced by a direct indexed lookup. |
| MEDIUM | `SaleVoucherFormPage.loadMasterData` loads all products + full inventory + all vouchers on mount. Acceptable at 30–40 articles; will not scale — noted. |
| LOW | Polling intervals in `App.tsx` (see R6). |

### R21 — Translation readiness
| Sev | Finding |
|---|---|
| MEDIUM **[partly fixed]** | No copy module existed; user-facing text is inline in all pages. `renderer/config/copy.ts` created and used by shared/auth components. Remaining pages deferred. |

### R22 — Dependencies
| Sev | Finding |
|---|---|
| OK | Dependencies are minimal (electron, react, react-dom, jsbarcode, esbuild, vitest, testing-library). Nothing added in this pass. |
| LOW **[fixed — §4.1.4]** | Root-level debug artefacts (`fix-sk12-price.js`, `fix-sk12-series.js`, `test-discount-debug.js`, `debug-discount-hierarchy.sql`, `tmp-product-debug.sqlite*`, `.tmp-data-test.txt`, `structure.txt`) and `packages/data/src/discount-live-audit.test.ts` (opens a live DB). Deleted / archived in the second pass. |

### R23 — Development discipline
| Sev | Finding |
|---|---|
| HIGH | The working directory is **not a git repository**. Commit discipline cannot be applied. **[decision]** |
| MEDIUM | `lint` scripts are `echo 'no lint configured yet'`. |

### R24 / R25 — AI readiness / external data validation
| Sev | Finding |
|---|---|
| OK | Business rules already sit behind `@erp/application` use cases and `SqliteDatabase` methods; a future AI service can call the same layer. |
| MEDIUM | Renderer trusts IPC responses (own main process — low risk today). When cloud sync arrives, `sync` payloads must be validated; the domain package now has a small `validate.ts` narrowing toolkit to use at that boundary. |

### Data durability (CLAUDE.md §9)
| Sev | Finding |
|---|---|
| CRITICAL **[fixed — §4.1.1]** | The SQLite database lived in `app.getPath("temp")/erp-desktop-runtime/erp.local.sqlite` — the Windows **temp** folder, which the OS may clean. Moving it to `userData` requires a one-time migration of the existing file. |
| HIGH | `migrations/sqlite/001_initial_schema.up.sql` is a placeholder; `local-schema.sql` is applied at boot. Upgrade history cannot be reconstructed from migrations alone. |

---

## 2. Target architecture (Phase 3)

Kept as-is, with the seams made explicit:

```text
React page
   ↓ useDesktopApi() / useSession()           (renderer; no business maths)
window.desktop.api                            (preload.cts; channel names from shared/ipcChannels.ts)
   ↓ ipcRenderer.invoke(IPC.xxx)
main.ts handler                               (authorize() → narrow input → call service)
   ↓
@erp/application use case  /  SqliteDatabase (business rules, transactions)
   ↓
SQLite (local, offline-first)  →  sync_outbox  →  @erp/sync (cloud, when available)
```

Shared business rules live in `@erp/domain` (`units.ts`, `money.ts`, `constants.ts`, `qr.ts`, `pricing.ts`) and are imported by **both** the renderer and the data layer so there is one formula for dozens/pairs/cartons, line totals, operational day, and QR parsing.

---

## 2a. What the compliance pass changed (2026-09-18)

**`@erp/domain`** — new `units.ts` (dozens/pairs/cartons, operational day), `money.ts` (paisa-exact arithmetic, `calculateSaleLine`), `constants.ts` (statuses, permissions, roles, discount sources…), `validate.ts` (runtime narrowing for IPC input). Stale compiled `index.js`/`qr.js`/`*.d.ts` removed from `src/`. 17 domain tests.

**`@erp/data`** — sale line totals, ledger running balances, purchase totals and the balance-limit check now use the domain money helpers; discount resolver debug logging removed; `ORDER BY` whitelist; typed `getParty`/`getSaleVoucher`/`listSaleVouchers`/`listParties`; `PartyBalanceLimitExceededError` class; `updateProduct.color` made optional (it was never read).

**`@erp/desktop` main** — `shared/ipcChannels.ts` (single registry of all 171 channels, used by both `main.ts` and `preload.cts`); `main/authorize.ts` (session-bound authorisation for every write handler, admin-only `reset-database`); `main/sessionStore.ts` (safeStorage-encrypted session + profiles); hand-typed 330-line `DesktopServices["db"]` replaced by the real `SqliteDatabase` type; all `any` removed; missing `list-unique-colors-by-article` handler added; `get-item-status` reads the QR registry instead of scanning 10,000 history rows; dead `returnHistory` map removed; preload bundled by esbuild (sandbox-safe); tsconfig moved to `NodeNext` so domain constants are shared with the main process.

**`@erp/desktop` renderer** — `App.tsx` 2,857 → 443 lines: `features/auth/*` (AuthScreen, RookieScreen, ProfilePage, ChangePasswordPage, FloatingProfileMenu, SessionContext, useAuthSession, session.ts), `features/users/*` (MemberSection, RolesSection, useAdminData, types), `features/reports/dailyReport.ts` (one daily-sheet template for production and dispatch), `app/pageTitles.ts`, `app/useRouteKeyboard.ts`, `app/HiddenSection.tsx`. Session token no longer touches `localStorage`. New shared modules: `platform/print.ts` (the only `window.open`), `utils/html.ts` (the only `escapeHtml`), `utils/dates.ts` (Asia/Karachi formatting), `utils/qr.ts` (display parsing via the domain parser), `config/copy.ts`, `components/shared/StateView.tsx`. All eight print sites escape user data and go through the platform module. Scanner pages use the shared QR utilities; Sale Voucher form and Customer Ledger use the domain line formula; token block in `theme.css` extended and 266 hex literals replaced with tokens.

**Verification** — `npm run build` passes; `@erp/domain` 17/17, `@erp/application` 45/45, `@erp/scanner` 3/3, `@erp/data` 96/102 (the same 6 pre-existing failures as before the pass), renderer 111/147 (the same 36 pre-existing failures, all on routes hidden by `visibleSections.ts` or test/implementation drift). Electron launched for 15 s without main-process or preload errors; a sign-in during that launch was persisted encrypted and decrypted back correctly.

## 3. Deferred items after the first pass (status of each in §4)

1. Split `SqliteDatabase` (7,600 lines) into per-module repositories behind the existing ports.
2. Split `main.ts` handlers into per-feature registration modules.
3. Replace the remaining ~900 hex/rgba literals in `theme.css` and page CSS strings with tokens.
4. Move remaining user-facing strings into `copy.ts`.
5. Migrate remaining `toLocale*` calls to `utils/dates.ts`.
6. Give every list page a `StateView`-based error/retry state.
7. Add `aria-label`s to remaining icon buttons.
8. Money schema migration REAL rupees → INTEGER paisa (business decision).

---

## 4. Critical remediation pass (2026-09-18, second pass)

Worked in the order asked: database location → money-schema audit → immutable history → dispatch unit conflict → root artefacts → remaining debt (A–G). Every batch was type-checked, tested and built before the next one. Nothing below changes a business rule that was not already written down elsewhere in the repo; where the rule was not written down, the change was **not** made and is recorded under 4.2.

### 4.1 Issues addressed

#### 4.1.1 Database stored in the Windows temp folder — FIXED
- **Issue.** `erp.local.sqlite` (and product images, logs, backups) lived under `app.getPath("temp")/erp-desktop-runtime`, which Windows may purge. All company data was one disk clean-up away from loss.
- **Root cause.** `main.ts` derived every runtime path from `temp`; the same folder mixed durable data with disposable cache, and nothing distinguished the two.
- **Files changed.** `apps/desktop/src/main/runtimePaths.ts` (new), `apps/desktop/src/main/runtimePaths.test.ts` (new, 9 tests), `apps/desktop/src/main.ts`, `apps/desktop/src/main/ipc/system.ts` (`get-runtime` now reports `dataRoot` and the migration report), `apps/desktop/src/renderer/types/desktopApi.ts`, `apps/desktop/vitest.config.ts`, `apps/desktop/tsconfig*.json`.
- **Solution.** One module resolves every path: durable data in `%LOCALAPPDATA%\777-erp` (falls back to Electron `appData`; `ERP_DATA_DIR` overrides for tests/ops), disposable cache/scratch in temp. On first launch the module performs a **verified copy** migration from the legacy roots (`temp/erp-desktop-runtime`, `appPath/.runtime/electron`): copies the DB with its `-wal`/`-shm` side files, product images, `app.log` and backups; runs `PRAGMA quick_check` on the copy; writes `data-migration.json`; only then switches over. The legacy folder is **not deleted**. `app.setPath("userData"/"sessionData")` point at the new root so `safeStorage` keys match. A single-instance lock prevents two processes opening the same DB.
- **Tests performed.** 9 unit tests (path resolution, env override, fresh install, migrated, already present, failed quick_check leaves legacy in place, side files copied). Live: launched the app twice — first launch reported `MIGRATED` with identical row counts before/after and the legacy DB intact; second launch reported `ALREADY_PRESENT`; a sign-in persisted and decrypted correctly under the new `userData`.
- **Status.** Done. Old data folder left in place for manual removal once the owner is satisfied.

#### 4.1.2 Money schema (REAL rupees) — AUDITED, NOT MIGRATED
- **Issue.** CLAUDE.md R15 requires integer paisa; every monetary column is `REAL` rupees.
- **Root cause.** Original schema; arithmetic was float until the first pass moved it to `@erp/domain/money.ts` (paisa-exact).
- **Files changed.** `docs/20-money-schema-audit.md` (new). No schema or data change.
- **Solution.** Full column inventory, where each is read/written, conversion rules, an additive migration plan (`*_paisa` columns → dual-write → reader switch flag → retire), backward compatibility, verification and rollback steps, and the decisions the owner must make first.
- **Tests performed.** None needed (documentation only). Existing money tests (`@erp/domain` 18/18) unchanged.
- **Status.** Blocked on business decision — see 4.2.2.

#### 4.1.3 Dispatch unit conflict (pair vs carton) — FIXED on documented evidence
- **Issue.** Backend allowed `dozens × 12` scans per line (treating a scan as a pair); the Live Dispatch screen treated a scan as a carton (`dozens × 2`) — 6× over-dispatch was possible.
- **Root cause.** `getDispatchSession` / `checkDispatchSessionAllowance` computed `requiredPairs` and compared it to a **count of scans**; no shared unit model existed.
- **Evidence used (not a guess).** `docs/16` and `PROJECT_CONTEXT.md` state 1 QR = 1 carton; `@erp/domain/units.ts` and `stock_projection` count cartons; Live Production, Store Move In/Out, Gatepass and Return all treat one scan as one carton; the sale voucher line stores `unit_qty = dozens × 2` (cartons). Only the dispatch allowance disagreed.
- **Files changed.** `packages/domain/src/units.ts` (`UNIT_MODEL`, `cartonsToPairs`, `pairsToCartons` + tests), `packages/data/src/database/dispatch.ts`, `packages/application/src/dispatchScanUseCase.ts`, `apps/desktop/src/renderer/pages/LiveDispatchPage.tsx`, `apps/desktop/src/renderer/types/desktopApi.ts`, `packages/data/src/sqliteDatabase.test.ts`, `apps/desktop/src/renderer/app/App.test.tsx`.
- **Solution.** The allowance is now `requiredCartons = dozensToCartons(line dozens)` vs `dispatchedCartons = COUNT(DISPATCHED events)`; pairs are reported alongside for display only. Screen and backend read the same fields. The failure mode is now the safe one (a scan is refused rather than over-shipped).
- **Tests performed.** Data test rewritten: a 1-dozen line accepts 2 cartons and refuses the 3rd with `ERROR: ITEM NOT IN SELECTED BILL`, stock unchanged, `remainingCartons` 2→0. Renderer "reloads bill progress" test updated and passing.
- **Status.** Done. If the owner ever wants pair-level dispatch, `UNIT_MODEL.scanUnit` is the one place to change.

#### 4.1.4 Root debug artefacts — CLEANED
- **Issue.** One-off scripts, a live-DB test and scratch files in the repo root.
- **Root cause.** Ad-hoc debugging left in place.
- **Files changed.** Deleted: `fix-sk12-price.js`, `fix-sk12-series.js`, `test-discount-debug.js`, `debug-discount-hierarchy.sql`, `DISCOUNT-DEBUG-INSTRUCTIONS.md`, `.tmp-data-test.txt`, `structure.txt`, `tmp-product-debug.sqlite*`, `packages/data/src/discount-live-audit.test.ts`. Archived (history worth keeping): `docs/archive/2026-08-20-erp-architecture-audit.md`, `2026-08-19-discount-hierarchy-analysis.md`, `2026-08-12-ui-changes-applied.md`, `2026-08-12-ui-redesign-summary.md`. `.gitignore` now excludes `apps/desktop/.runtime/`, `tmp-*.sqlite*`, `*.sqlite-wal/-shm`, `.tmp-*`.
- **Solution.** Each file's references were grepped first; none was imported by application code or npm scripts.
- **Tests performed.** Build and all suites after removal.
- **Status.** Done.

#### 4.1.5 `sqliteDatabase.ts` split by feature (6A) — DONE
- **Issue.** 7,600-line class.
- **Files changed.** `packages/data/src/sqliteDatabase.ts` (core, 588 lines: boot, migrations, transactions, settings, backups, health), `packages/data/src/database/{types,shared,production,products,barcodes,dispatch,store,gatepass,users,rawMaterials,parties,sales,cash,purchases}.ts` (new).
- **Solution.** Each feature module exports a method object typed with `this: SqliteDatabase`; the core class merges them (`interface SqliteDatabase extends …Methods` + `Object.assign(SqliteDatabase.prototype, …)`). **Public API unchanged** — every caller still calls `db.method()`; SQL bodies were moved verbatim.
- **Tests performed.** `@erp/data` 95/101 (same 6 pre-existing failures), build, app boot with the live DB.
- **Status.** Done.

#### 4.1.6 `main.ts` decomposition (6B) — DONE
- **Files changed.** `apps/desktop/src/main.ts` (1,900 → 192 lines), `apps/desktop/src/main/ipc/{context,index,session,users,workspace,rawMaterials,products,barcodes,reports,scanning,store,gatepass,parties,sales,cash,purchases,system}.ts` (new).
- **Solution.** `createIpcContext` builds the Authorizer, session store, use cases and paths once; each feature file registers its handlers from `shared/ipcChannels.ts` and calls `authorize()` exactly as before (handler bodies moved verbatim).
- **Tests performed.** Main tsc, app boot, sign-in, scan and voucher smoke through the running app.
- **Status.** Done.

#### 4.1.7 Design tokens (6C) — DONE with classification
- **Files changed.** `styles/theme.css` (new tokens: neutral scale, success/warning/danger tint/strong/deep, accent tint/mid/deep, glass and line alphas, overlays), 24 renderer files.
- **Solution.** Literals were **classified** before replacement: (a) theme colours → tokens (281 hex + 104 rgba in CSS; 291 hex + 24 rgba in TSX); (b) **product colour swatches** (`StockPage.getColorHex`, `LiveProductionPage.COLOR_MAP` — physical slipper colours) kept literal and commented; (c) **print documents** (`gatepassPrint.ts`, `rateList.ts`, `barcodeLabels.tsx`, `dailyReport.ts`, inline print HTML in ProductionHistory/Stock/DiscountPolicy) kept literal because they render in a window without `theme.css`; (d) SVG stroke/fill data untouched; (e) two accidental self-references (`--ink-2: var(--ink-2)`) caught and reverted. Remaining one-offs: 41 hex + 148 rgba in CSS, 294 hex + 80 rgba in TSX (page-scoped `--pro-*`/`--out-*`/`--sky-*` palettes and shadows).
- **Tests performed.** Renderer tsc, vitest, Vite build.
- **Status.** Done for this pass; page-local palettes listed under remaining debt.

#### 4.1.8 Copy centralisation (6D) — DONE for repeated strings
- **Files changed.** `renderer/config/copy.ts` (+ `toast`, `actions`, `columns`, `filters`, `empty`, `stock`, `gatepass`, `products`, scanner labels), 48 renderer files (528 replacements).
- **Solution.** Toast titles (12 spellings of "load failed" → one), common actions, table column headings, filter/empty-state labels and scanner labels now come from `copy.ts`. Print templates and template literals were excluded automatically. Nav labels remain in the two structured config objects (`Navbar.NAV`, `app/pageTitles.ts`), which are already centralised.
- **Tests performed.** Renderer tsc, vitest (values unchanged, so label-based tests still pass).
- **Status.** Done. "Color" vs "Colour" spelling is inconsistent between older and newer pages — wording decision for the owner (not changed).

#### 4.1.9 Dates and money display (6E) — DONE
- **Issue.** Two real defects found while auditing `toLocale*`: (1) **"today" was computed as the UTC date** (`new Date().toISOString().slice(0,10)`) for default voucher dates, ledger "as of" dates and history filters — between 00:00 and 05:00 Karachi time every night the default date was **yesterday**; (2) seven pages each defined their own `fmtNum` money formatter.
- **Files changed.** `renderer/utils/dates.ts` (+ `isoDateDaysAgo`, `shiftIsoDate`, `formatMonth`, `formatDateWithWeekday`), `renderer/app/format.ts` (+ `formatWholeMoney`), and 22 pages/components (Cash/Sale/Purchase voucher forms and lists, Customer/Supplier ledger and balance, Raw-material ledger, Production/Dispatch/Return history, QR Management/Journey, Workspace, Store Home, Barcode Generator, Product List/Products, Discount Policy, Production scanner panel).
- **Solution.** All "today" defaults use `toIsoDate()` (business timezone — already the documented rule in `dates.ts`); all date display goes through the central formatters; the exclusive upper bound for "to" dates uses `shiftIsoDate`. Whole-rupee ledger figures use one formatter with output identical to the per-page copies. `QrManagementPage`'s **filter-day** helpers were deliberately left machine-local (documented in code as matching the database).
- **Tests performed.** Renderer tsc, vitest.
- **Status.** Done. Remaining `toLocaleString()` calls format integer counts only.

#### 4.1.10 StateView on async screens (6F) — DONE for active list routes
- **Files changed.** `pages/StockPage.tsx`, `pages/GatepassListPage.tsx`, `pages/ProductListPage.tsx`, `config/copy.ts`.
- **Solution.** Loading / error-with-retry / empty (distinguishing "nothing yet" from "no match") through the shared `StateView`. **Also removed from the Stock page four hard-coded fake KPI trends** ("▲ 5.1% vs yesterday", "▲ 6.3% vs yesterday" …) that had no data behind them — placeholders presented as business figures — and replaced the ₹ (Indian rupee) icon with "Rs".
- **Tests performed.** Renderer tsc, vitest (GatepassList 5/5, ProductList unchanged).
- **Status.** Done for active routes; hidden routes listed under remaining debt.

#### 4.1.11 Accessibility (6G) — DONE for active routes and shared components
- **Files changed.** `StockPage` (search, rows-per-page, page buttons), `ProductListPage` (six filter-chip "×" buttons, search, three combobox inputs now tied to their visible labels), `LiveDispatchPage` (both scanner inputs), `ExportModal` (search), `SettingsPage` (label↔input association), `PartyFormPage` (modal close), `MemberSection` (permission remove), `SaleVoucherFormPage` (stock badge was colour-only → now carries "in stock / out of stock" text), `theme.css` (`.sr-only` utility).
- **Solution.** Every fix adds a name without changing behaviour; the audit script parses JSX attributes with brace balancing so multi-line handlers are not misread.
- **Tests performed.** Renderer tsc, vitest.
- **Status.** Done for active routes; ~90 unlabeled inputs remain on hidden routes (Cash/Purchase voucher forms, Inventory Categories, Raw-material pages, History pages).

#### 4.1.12 Bootstrap admin credentials hard-coded — FOUND, NOT CHANGED
- **Issue.** `packages/data/src/database/users.ts` `isBootstrapAdmin()` grants ADMIN to a fixed username/password literal in source, used by `authenticate` and profile switching.
- **Why not changed.** Removing it could lock the owner out of an installed system; replacing it (first-run setup, env-provided bootstrap, or DB-seeded hash) is a security design decision with operational impact. Recorded under 4.2.4.

### 4.2 Issues blocked on a business decision

#### 4.2.1 `deleteSaleVoucher` destroys production history — STOPPED
- **Issue.** `packages/data/src/database/sales.ts` `deleteSaleVoucher` (lines 651–692) physically `DELETE`s `production_events` rows and their `sync_outbox` entries, flips `qr_master` back to `PRODUCED`, and re-adds stock — contradicting `docs/16` ("production_events is immutable") and CLAUDE.md §9.
- **Trace.** Callers: IPC `erp:delete-sale-voucher` (`main/ipc/sales.ts:377`, authorised) ← `preload.cts:197` ← `SaleVoucherFormPage.tsx:656` and `SaleVoucherListPage.tsx:63`. The events it deletes are chosen **heuristically**: every `DISPATCHED` event after `voucher.created_at` whose variant matches any line's **article + size** (not the variant, not the voucher). DISPATCHED events store no voucher or session id (`dispatch.ts:228–250`; `metadata_json` holds only `parserVersion`/`eventType`), so the query cannot know which bill a scan belonged to.
- **Why blocked (what could go wrong).** (1) Deleting voucher A can silently undo dispatch scans that belong to voucher B for the same article/size; (2) the location restore is always `FACTORY`, but a carton dispatched from the store (STORE_EXIT → TO_GATE) would be restored to the wrong location; (3) deleting outbox rows means the cloud never learns the events existed; (4) no test covers this path. Any change here rewrites what "cancelling a bill" means for stock and audit — a business rule.
- **Decision required.** Choose one: **(a)** cancellation is *audit-preserving*: keep every DISPATCHED event, write compensating `RETURNED`/`ADJUSTMENT` events per carton, restore location from the last event before dispatch, and record `voucher_id`/`session_id` in `metadata_json` on every DISPATCHED event so cancellation is exact; or **(b)** cancellation is *forbidden once any carton has been dispatched* (a voucher can only be cancelled while its dispatch session has zero scans); or **(c)** keep today's behaviour knowingly. (a) is what `docs/16` implies.
- **Code that must NOT change until decided.** `deleteSaleVoucher` in `packages/data/src/database/sales.ts`; the `DISPATCHED` insert in `packages/data/src/database/dispatch.ts`; the `delete-sale-voucher` handler; the two page call sites.

#### 4.2.2 Money columns REAL rupees → INTEGER paisa — DECISION
- **Why blocked.** Migrates every voucher, ledger, cash and price row; historical totals must reproduce to the paisa; the sync/cloud schema must move in step. Plan and verification steps are in `docs/20-money-schema-audit.md`.
- **Decision required.** Approve the additive plan in docs/20 (new `*_paisa` columns, dual-write, reader flag, retire), the rounding rule for existing fractional values, and the cut-over window.
- **Code that must NOT change until decided.** `packages/data/src/local-schema.sql` money columns; any `INSERT/UPDATE` touching `unit_price`, `total_price`, `discount*`, `receipt_amount`, `payment_amount`, `total_amount`, `balance_limit`, `selling_price`, `cost_price`.

#### 4.2.3 Backend-resolved discount vs UI-supplied discount total — DECISION (carried over)
- Unchanged from §1 R9. The backend should be authoritative; making it so changes what a clerk can override on a bill.

#### 4.2.4 Hard-coded bootstrap admin — DECISION
- **Decision required.** How the first administrator is created and recovered: first-run setup screen, `ERP_BOOTSTRAP_ADMIN` environment/seed file consumed once, or a seeded password hash in `users` — and whether the current literal account must keep working on installed machines during the transition.
- **Code that must NOT change until decided.** `isBootstrapAdmin`, `authenticate`, `switchProfile` in `packages/data/src/database/users.ts`.

#### 4.2.5 External in-progress edit: `transportVia` → `transportRickshaw` — NOT PART OF THIS PASS, BLOCKS BUILD
- `apps/desktop/src/renderer/pages/GatepassPage.tsx` and `GatepassPage.test.tsx` were modified at 19:48 on 2026-09-18 **outside this remediation** (the last remediation edit to those files was 18:14). They now send `transportRickshaw`, while `types/desktopApi.ts`, the IPC handler, `packages/data/src/database/gatepass.ts`, `local-schema.sql` (`transport_via`) and the print template still use `transportVia`. The renderer type-check reports two errors (`GatepassPage.tsx:447`, `GatepassPage.test.tsx:48`) and `npm run build` fails on that step; runtime tests still pass because the unknown field is simply dropped.
- **Decision required.** Whether the field is being renamed end-to-end (type → IPC → DB column/migration → print) or the page should keep `transportVia` with a "Rickshaw" label. Not changed here because it is someone else's work in flight.

### 4.3 Summary

**CRITICAL ISSUES FIXED**
1. Database moved out of the temp folder into a persistent app-data location with verified copy migration, single-instance lock and tests (4.1.1).
2. Dispatch over-shipment: the allowance now counts cartons on both sides, matching the documented unit model (4.1.3).
3. Default "today" dates were UTC dates — wrong for five hours every night on voucher, ledger and history screens; now business-timezone (4.1.9).
4. Fake KPI trend figures removed from the Stock page (4.1.10).
5. Root debug scripts and a live-DB test removed; useful analyses archived (4.1.4).

**BUSINESS DECISIONS REQUIRED**
1. Bill cancellation vs immutable production history (4.2.1) — highest risk; do not touch `deleteSaleVoucher` until decided.
2. Money schema migration to integer paisa (4.2.2; plan in docs/20).
3. Backend-authoritative discount on sale lines (4.2.3).
4. Bootstrap admin credentials in source (4.2.4).
5. Gatepass `transportRickshaw` rename in flight (4.2.5).
6. Wording: "Color" vs "Colour"; PKR display with/without decimals.

**ARCHITECTURAL REFACTORING COMPLETED**
- `SqliteDatabase` split into 12 feature modules behind an unchanged API (4.1.5).
- `main.ts` reduced to composition; 171 IPC handlers registered per feature with the existing channel registry and Authorizer (4.1.6).
- Design tokens classified and applied (theme vs product-colour vs print vs SVG) (4.1.7).
- Copy, dates and money display centralised; StateView and accessible names on all active routes (4.1.8–4.1.11).

**TEST RESULTS** (final run, 2026-09-18)
- `@erp/domain` 18/18 · `@erp/application` 45/45 · `@erp/scanner` 3/3.
- `@erp/data` 95/101 — the same 6 pre-existing failures as the baseline (tests 40, 47, 48, 53, 60, 63: role overrides, variant metadata, ArticleSize price sharing, discount metadata, dispatch-session variant matching, offline product CRUD). None introduced by this pass.
- Desktop renderer + main (vitest) 121/156 — the same 35 pre-existing failures as the baseline (36 minus the dispatch test fixed here), all on routes hidden by `visibleSections.ts` or stale mocks (`listPartyGroups`, `getNextProductCode`); the 9 new `runtimePaths` tests pass.

**BUILD RESULT**
- All packages compile; the desktop main process compiles; the renderer bundle builds. **`npm run build` exits non-zero on the renderer type-check because of the external `transportRickshaw` edit (4.2.5)** — two errors, both in files changed outside this pass. Before that edit the same command passed (end of 6C).

**REMAINING TECHNICAL DEBT**
1. Hidden-route pages (Cash/Purchase vouchers, Inventory Categories, Raw-material pages, History pages): StateView error/retry, ~90 unlabeled inputs, remaining inline strings.
2. Page-local colour palettes (`--pro-*`, `--out-*`, `--sky-*`, `--ink-*`) in Live Production / Store pages and ~300 remaining hex literals in TSX.
3. Two product-colour swatch maps (`StockPage.getColorHex`, `LiveProductionPage.COLOR_MAP`) with different values — should become one `utils/productColours.ts` once the owner picks the palette.
4. `visibleSections.ts` hides 30+ routes; their tests fail by design and should be skipped explicitly or the routes re-enabled.
5. `migrations/sqlite/001_initial_schema.up.sql` is still a placeholder; `local-schema.sql` is applied at boot.
6. No git repository, no lint configuration.
7. Redux/RTK Query/RHF/Zod/Tailwind remain intentionally absent; the agreed equivalents are `shared/ipcChannels.ts`, `useDesktopApi`, `SessionContext`, `@erp/domain/validate.ts` and `theme.css` tokens (see §0).

Compliance is **not** complete while 4.2.1 and 4.2.2 are open: both concern historical financial/production data and must not be changed without the owner's decision.
