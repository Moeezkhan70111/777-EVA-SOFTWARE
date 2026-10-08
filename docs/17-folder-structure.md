# Folder Structure

```text
apps/desktop
  src/main.ts                 Electron main: resolve paths → migrate legacy data → compose services → register IPC → window
  src/preload.cts             contextBridge → window.desktop.api (bundled by esbuild; sandbox-safe)
  src/main/                   main-process modules
    runtimePaths.ts           durable data root (%LOCALAPPDATA%/777-erp, ERP_DATA_DIR override) vs temp cache; verified copy migration from the old temp folder
    authorize.ts              session-bound authorisation for write handlers
    sessionStore.ts           safeStorage-encrypted session + saved profiles
    ipc/                      one file per feature; each exports register<Feature>Handlers(ctx)
      context.ts              IpcContext (db, logger, authorizer, sessionStore, use cases, paths) + createIpcContext
      index.ts                registerIpcHandlers — calls every feature registrar
      session · users · workspace · rawMaterials · products · qrCodes · reports · scanning · store · gatepass · parties · sales · cash · purchases · system
  src/shared/
    ipcChannels.ts            the ONE registry of IPC channel names (renderer ↔ main "endpoints")
  src/renderer/
    app/                      shell: App, routes, page titles, keyboard routing, visibleSections
    features/                 feature-local code (CLAUDE.md R11)
      auth/                   sign-in screens, session model, SessionContext, useAuthSession
      users/                  member & role administration
      reports/                shared daily-sheet report (production / dispatch)
      gatepass/               create screen: draft model (gatepassDraft), hooks (data / draft / balance / images), cards, picker, summary panel
      billing/                sale voucher from a gatepass: line mapping (cartons → dozens), gatepass link banner
    pages/                    one component per screen
    components/
      layout/                 Navbar, NotificationCenter, Sidebar
      shared/                 StateView (loading / empty / error), ExportModal
    platform/                 native-environment abstractions (print.ts) — pages never call window.open
    config/copy.ts            user-facing text (translation seam)
    utils/                    dates.ts (Asia/Karachi), html.ts (escapeHtml), qr.ts, rate list, gatepass print, sale voucher print
    state/                    NotificationsContext
    styles/theme.css          design tokens (:root) + component CSS
    types/desktopApi.ts       renderer-side contract for window.desktop.api

packages
  domain/                     business vocabulary and rules with no I/O
    qr.ts                     QR parser / identity builder
    units.ts                  dozens · pairs · cartons, operational day (06:00 → 06:00)
    money.ts                  paisa-exact arithmetic, sale line formula
    pricing.ts                B-TYPE price rule
    constants.ts              statuses, roles, permissions, discount sources…
    validate.ts               runtime narrowing for untrusted input
  application/                use cases and ports (scan, dispatch, return, store, gatepass, party)
  data/                       SqliteDatabase (implements the ports), local-schema.sql, logger
    src/sqliteDatabase.ts     core: boot, migrations, transactions, settings, backups, health — merges the feature modules below
    src/database/types.ts     every exported row/record type and PartyBalanceLimitExceededError
    src/database/shared.ts    orderBy whitelist, MutableTransactionContext, text normalisation
    src/database/<feature>.ts production · products · qrCodes · dispatch · store · gatepass · users · rawMaterials · parties · sales · cash · purchases
                              (method objects typed `this: SqliteDatabase`; callers still use db.method())
  scanner/                    ScannerFrameAssembler (not yet wired)
  sync/                       OutboxSyncService (cloud seam; stub)

migrations/sqlite             versioned schema migrations
supabase/                     cloud schema baseline
docs/                         architecture and audit documents (19 = compliance audit + remediation log, 20 = money schema audit)
docs/archive/                 superseded analyses kept for history
```

Guidelines:
- Business rules live in `packages/domain` and `packages/application`; the renderer and the data layer both import them so there is one formula.
- Platform-specific implementations stay in `packages/data`, `apps/desktop/src/main` and `renderer/platform`.
- A new IPC call is added to `shared/ipcChannels.ts` first, then to `preload.cts` and the matching `src/main/ipc/<feature>.ts`.
- A new database method goes into the matching `packages/data/src/database/<feature>.ts` method object; its row types into `database/types.ts`.
- "Today" for date inputs/filters is `toIsoDate()` from `renderer/utils/dates.ts` (business timezone) — never `toISOString().slice(0, 10)`.
- New feature code goes under `renderer/features/<feature>/`; promote to `components/shared` only when a second feature needs it.
