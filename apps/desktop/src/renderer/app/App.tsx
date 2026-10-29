import React, { useCallback, useMemo, useRef, useState } from "react";
import { ACCESS_STATUS, PERMISSION, USER_ROLE } from "@erp/domain";
import { Navbar } from "../components/layout/Navbar";
import { NotificationCenter } from "../components/layout/NotificationCenter";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { useNumberRangeWarning } from "../hooks/useNumberRangeWarning";
import { DashboardPage } from "../pages/DashboardPage";
import { StockPage } from "../pages/StockPage";
import { RawMaterialInputPage } from "../pages/RawMaterialInputPage";
import { RawMaterialOutputPage } from "../pages/RawMaterialOutputPage";
import { RawMaterialWorkspace } from "../features/rawMaterial/RawMaterialWorkspace";
import { MachineProgramPage } from "../features/machineProgram/MachineProgramPage";
import { ProductionHistoryPage } from "../pages/ProductionHistoryPage";
import { HistoryPage } from "../pages/HistoryPage";
import { LiveProductionPage } from "../pages/LiveProductionPage";
import { DailyProductionPage } from "../pages/DailyProductionPage";
import { DailyDispatchPage } from "../pages/DailyDispatchPage";
import { LiveDispatchPage } from "../pages/LiveDispatchPage";
import { DispatchHistoryPage } from "../pages/DispatchHistoryPage";
import { LiveReturnPage } from "../pages/LiveReturnPage";
import { ReturnHistoryPage } from "../pages/ReturnHistoryPage";
import { StoreHomePage } from "../features/store/StoreHomePage";
import { StoreInPage } from "../features/store/StoreInPage";
import { StoreOutPage } from "../features/store/StoreOutPage";
import { StoreOutReportPage } from "../features/store/dailyReport/StoreOutReportPage";
import { storeInTabOfRoute } from "../features/store/storeOperators";
import { StorePage } from "../features/store/page/StorePage";
import { STORE_MODE_ROUTE, storeModeOfRoute } from "../features/store/page/storeTabs";
import { StoreWorkspacePage } from "../features/store/StoreWorkspacePage";
import { StoreScanningPage } from "../pages/StoreScanningPage";
import { StoreMoveOutPage } from "../pages/StoreMoveOutPage";
import { GatepassPage } from "../pages/GatepassPage";
import { GatepassListPage } from "../pages/GatepassListPage";
import { GatepassScanPage } from "../features/gatepass/GatepassScanPage";
import { QrJourneyPage } from "../pages/QrJourneyPage";
import { PartyListPage } from "../pages/PartyListPage";
import { PartyFormPage } from "../pages/PartyFormPage";
import { CustomerLedgerPage } from "../pages/CustomerLedgerPage";
import { CustomerBalancePage } from "../pages/CustomerBalancePage";
import { ProductListPage } from "../pages/ProductListPage";
import { ProductFormPage } from "../pages/ProductFormPage";
import { QrGeneratorWorkspace } from "../features/qrGenerator/QrGeneratorWorkspace";
import { QrManagementPage } from "../pages/QrManagementPage";
import { ProductListsPage } from "../pages/ProductListsPage";
import { DiscountPolicyPage } from "../pages/DiscountPolicyPage";
import { SaleVoucherFormPage } from "../pages/SaleVoucherFormPage";
import { SaleVoucherListPage } from "../pages/SaleVoucherListPage";
import { PurchaseVoucherFormPage } from "../pages/PurchaseVoucherFormPage";
import { PurchaseVoucherListPage } from "../pages/PurchaseVoucherListPage";
import { SupplierLedgerPage } from "../pages/SupplierLedgerPage";
import { ContractorLedgerPage } from "../features/contractorLedger/ContractorLedgerPage";
import { SupplierBalancePage } from "../pages/SupplierBalancePage";
import { CashVoucherFormPage } from "../pages/CashVoucherFormPage";
import { CashVoucherListPage } from "../pages/CashVoucherListPage";
import { SettingsPage } from "../pages/SettingsPage";
import { HealthPage } from "../pages/HealthPage";
import { LogsPage } from "../pages/LogsPage";
import { WorkspacePage } from "../pages/WorkspacePage";
import type { AppRoute } from "./routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { isRouteActive, NAV_ACTIVE } from "./visibleSections";
import { HiddenSection } from "./HiddenSection";
import { useRouteKeyboard } from "./useRouteKeyboard";
import { copy } from "../config/copy";
import { AuthScreen } from "../features/auth/AuthScreen";
import { BootstrapAdminScreen } from "../features/auth/BootstrapAdminScreen";
import { RookieScreen } from "../features/auth/RookieScreen";
import { ProfilePage } from "../features/auth/ProfilePage";
import { ChangePasswordPage } from "../features/auth/ChangePasswordPage";
import { FloatingProfileMenu } from "../features/auth/FloatingProfileMenu";
import { SessionProvider } from "../features/auth/SessionContext";
import { useAuthSession } from "../features/auth/useAuthSession";
import { canOpenRoute, hasPermission, HOME_ROUTE, landingRoute } from "../features/auth/session";
import type { AuthUser } from "../types/desktopApi";
import { MunshiHomePage } from "../features/munshi/MunshiHomePage";
import { HomePage } from "../features/navigation/HomePage";
import { useStoreJob } from "../features/store/useStoreJob";
import { useAdminData } from "../features/users/useAdminData";
import { notificationTarget } from "../features/users/notificationTarget";
import type { UserNotification } from "../features/users/types";

export type { SavedProfile } from "../features/auth/session";

/** Screens that take the whole window (scanner stations); everything else sits under the navbar. */
const FULLSCREEN_ROUTES: ReadonlySet<AppRoute> = new Set<AppRoute>([
  "live-production",
  "live-dispatch",
  "live-return",
  "store-home",
  "store-in-operator",
  "store-in-new-material",
  "store-in-qr-generator",
  "store-in-scanner",
  "store-in-stock",
  "store-in-receipts",
  "store-in-setup",
  "store-in-manual-entry",
  "store-in-daily-report",
  "store-out-operator",
  "store-receiving",
  "store-issuing",
  "store-out-daily-report",
  "munshi-home",
  "munshi-stock",
  "store-scanning",
  "store-move-out",
]);

type WorkspaceTab = "messages" | "tasks" | "requests" | "notifications" | "activity";

export const App = () => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  // Automatic updates: silent until a downloaded version is waiting, then one "Restart Now"
  // prompt. Mounted here because it belongs to the application, not to any one screen.
  useAppUpdate();
  const [route, setRoute] = useState<AppRoute>(HOME_ROUTE);
  const [workspaceTab] = useState<WorkspaceTab>("tasks");
  const [selectedProductId, setSelectedProductId] = useState<string | undefined>(undefined);
  const [selectedPartyId, setSelectedPartyId] = useState<string | undefined>(undefined);
  /** The gatepass the Sale Voucher screen was opened for (from a notification). */
  const [saleVoucherGatepassId, setSaleVoucherGatepassId] = useState<string | undefined>(undefined);
  /** The raw material the workspace was opened for (from a stock-correction notification). */
  const [rawMaterialItemId, setRawMaterialItemId] = useState<string | undefined>(undefined);
  /** The machine program Store Out was opened for (from a machine-program notification). */
  const [storeOutProgramId, setStoreOutProgramId] = useState<string | undefined>(undefined);
  /** The machine program Reconciliation was opened for (Start Reconciliation on Machine Program). */
  const [reconcileProgramId, setReconcileProgramId] = useState<string | null>(null);
  // It is for that one visit: leaving the QR Generator lets the next visit open on its first tab.
  React.useEffect(() => {
    if (route !== "qr-generator") setReconcileProgramId(null);
  }, [route]);
  const [appVersion, setAppVersion] = useState("");

  const auth = useAuthSession({ api, push, route, setRoute });
  // A store operator's picked job, which decides what their sidebar lists.
  const storeJob = useStoreJob(route);
  const { session, sessionToken, savedProfiles, isAddingAccount, authView, authError, authSuccess, requestStatus, needsBootstrap } = auth;
  const admin = useAdminData({ api, push, session, sessionToken, setAuthError: auth.setAuthError });
  // Said at sign-in, not at the printer: a computer with no number range can neither create a
  // numbered document nor print a QR label, and both refuse far too late to be useful.
  useNumberRangeWarning(session?.id ?? null);

  // App version for the navbar; settings are read once so the main process warms its cache.
  React.useEffect(() => {
    void (async () => {
      const runtime = await api.getRuntime();
      await api.getSettings();
      setAppVersion(`v${runtime.appVersion}`);
    })();
    document.documentElement.removeAttribute("data-theme");
  }, [api]);

  const onBackup = useCallback(async () => {
    try {
      const backup = await api.createBackup();
      push("success", copy.backup.createdTitle, copy.backup.createdBody(backup.backupPath, Math.round(backup.sizeBytes / 1024)));
    } catch (error) {
      push("error", copy.backup.failedTitle, error instanceof Error ? error.message : copy.common.unknownError);
    }
  }, [api, push]);

  // Read through a ref so the keyboard handler stays stable across the 3-second
  // session refresh instead of re-registering on every tick.
  const sessionRef = useRef<AuthUser | null>(null);
  sessionRef.current = session;

  const onEscape = useCallback(() => {
    // Don't navigate if a child component has mounted a suppress-esc sentinel
    // (e.g. ProductFormPage add-group modals, PartyFormPage city dropdown open)
    if (document.querySelector("[data-suppress-esc]")) return;
    // Escape means "start again": Store Station for a store operator, the Dashboard for others.
    setRoute(landingRoute(sessionRef.current));
  }, []);

  useRouteKeyboard(setRoute, onBackup, onEscape);

  const navigateTo = useCallback((next: AppRoute, id?: string) => {
    setSelectedProductId(id);
    setRoute(next);
  }, []);
  const navigateToParty = useCallback((next: AppRoute, id?: string) => {
    setSelectedPartyId(id);
    setRoute(next);
  }, []);
  const leaveForm = useCallback((next: AppRoute) => {
    setSelectedProductId(undefined);
    setSaleVoucherGatepassId(undefined);
    setRoute(next);
  }, []);
  /** A gatepass notice opens the Sale Voucher screen for that gatepass. */
  const openSaleVoucherForGatepass = useCallback((gatepassId: string) => {
    setSelectedProductId(undefined);
    setSaleVoucherGatepassId(gatepassId);
    setRoute("sale-voucher-form");
  }, []);
  /** Every other gatepass notice opens the document itself, where its journey is shown. */
  const openGatepassDocument = useCallback((gatepassId: string) => {
    setSaleVoucherGatepassId(undefined);
    setSelectedProductId(gatepassId);
    setRoute("gatepass-list");
  }, []);
  /** A stock-correction notice opens that raw material, with its drawer already open. */
  const openRawMaterialItem = useCallback((itemId: string) => {
    setRawMaterialItemId(itemId);
    setRoute("raw-material");
  }, []);
  /**
   * A machine-program notice opens Store Out on that program. The stored id travels, and the
   * main process still resolves it and judges whether it may be issued against — clicking a
   * notice is not authorisation.
   */
  const openStoreOutForProgram = useCallback((programId: string) => {
    setStoreOutProgramId(programId);
    setRoute("store-out-operator");
  }, []);
  const onNotificationClick = useCallback(
    (notification: UserNotification) => {
      admin.handleNotificationClick(notification);
      const target = notificationTarget(notification);
      if (!target) return;
      if (target.route === "sale-voucher-form") openSaleVoucherForGatepass(target.gatepassId);
      else if (target.route === "gatepass-list") openGatepassDocument(target.gatepassId);
      else if (target.route === "store-out-operator") openStoreOutForProgram(target.programId);
      else openRawMaterialItem(target.itemId);
    },
    [admin, openSaleVoucherForGatepass, openGatepassDocument, openRawMaterialItem, openStoreOutForProgram]
  );
  const leavePartyForm = useCallback((next: AppRoute) => {
    setSelectedPartyId(undefined);
    setRoute(next);
  }, []);

  // Every approved role gets the sidebar; what it lists comes from the role's permissions.
  // A user still waiting for access sees only the Rookie screen and the floating profile menu.
  const showNavbar = !!session && NAV_ACTIVE && session.accessStatus === ACCESS_STATUS.APPROVED;

  const content = useMemo(() => {
    if (needsBootstrap) {
      return <BootstrapAdminScreen error={authError} onSubmit={auth.handleBootstrapSubmit} />;
    }

    if (!session || isAddingAccount) {
      return (
        <AuthScreen
          view={authView}
          error={authError}
          onSubmit={auth.handleAuthSubmit}
          onSwitch={auth.setAuthView}
          onCancel={session && isAddingAccount ? auth.cancelAddAccount : undefined}
        />
      );
    }

    if (session.accessStatus !== ACCESS_STATUS.APPROVED) {
      return <RookieScreen requestStatus={requestStatus} onRequest={auth.handleRequestAccess} error={authError} />;
    }

    // A page this role has not been given (a keyboard shortcut, a stale route after the
    // role changed) falls back to Home rather than to any one page.
    const home = <HomePage user={session} onNavigate={setRoute} />;
    if (!canOpenRoute(session, route)) return home;

    const canOpenRawMaterial = canOpenRoute(session, "raw-material");

    if (!isRouteActive(route)) {
      return <HiddenSection />;
    }

    switch (route) {
      case "profile":
        return (
          <ProfilePage
            username={session.username}
            onLogout={auth.handleLogout}
            onChangePassword={() => setRoute("change-password")}
            members={session.role === USER_ROLE.ADMIN ? admin.members : undefined}
            roleOptions={admin.roleOptions}
            roles={admin.roles}
            onPermissions={admin.handleMemberPermissions}
            onRevoke={admin.handleMemberRevoke}
            onReview={admin.handleReviewAccessRequest}
            onJobRole={admin.handleMemberJobRole}
            onAuthority={admin.handleMemberAuthority}
            onAssignRole={admin.handleMemberRoleAssignment}
            onSetAdditionalPermissions={admin.handleSetAdditionalPermissions}
            onCreateRole={admin.handleCreateRole}
            onUpdateRole={admin.handleUpdateRole}
            onDeleteRole={admin.handleDeleteRole}
          />
        );
      case "change-password":
        return (
          <ChangePasswordPage
            onSubmit={auth.handleChangePassword}
            onCancel={() => setRoute("profile")}
            error={authError}
            success={authSuccess}
          />
        );
      case "home":
        return home;
      case "dashboard":
        return <DashboardPage />;
      case "stock":
        return <StockPage />;
      // One workspace, three doors. The two deep-link routes keep the permission their old
      // page had, and open on the tab that replaced it.
      case "raw-material":
      case "raw-material-setup":
      case "raw-material-qr-generator":
        return (
          <RawMaterialWorkspace
            initialTab={route === "raw-material-setup" ? "setup" : route === "raw-material-qr-generator" ? "labels" : "stock"}
            username={session.username}
            permissions={session.permissions}
            allowAll={session.role === USER_ROLE.ADMIN}
            initialItemId={rawMaterialItemId}
            onInitialItemConsumed={() => setRawMaterialItemId(undefined)}
            onNavigate={setRoute}
          />
        );
      // The scanners offer a shortcut into the Raw Material workspace (that is where a
      // "PACKING NOT SET" refusal gets fixed), but only to an operator who can actually open
      // it — otherwise the button would land them back on the dashboard.
      case "raw-material-input":
        return (
          <RawMaterialInputPage
            token={sessionToken ?? ""}
            username={session.username}
            onBack={() => setRoute("store-home")}
            onNavigate={canOpenRawMaterial ? setRoute : undefined}
          />
        );
      case "raw-material-output":
        return (
          <RawMaterialOutputPage
            token={sessionToken ?? ""}
            username={session.username}
            onBack={() => setRoute("store-home")}
            onNavigate={canOpenRawMaterial ? setRoute : undefined}
          />
        );
      // The machines with their two contractors, and each machine's program for a day. Programs
      // open from the QR Generator; the old shift-planning workflow was retired in Phase 1.
      case "machine-program":
        return (
          <MachineProgramPage
            isAdmin={session.role === USER_ROLE.ADMIN}
            onOpenQrGenerator={canOpenRoute(session, "qr-generator") ? () => setRoute("qr-generator") : undefined}
            // Reconciliation lives in the QR Generator workspace; the program travels with the route.
            onStartReconciliation={canOpenRoute(session, "qr-generator") ? (programId) => {
              setReconcileProgramId(programId);
              setRoute("qr-generator");
            } : undefined}
          />
        );
      case "history":
      case "stock-history":
        return <HistoryPage />;
      case "production-history":
        return <ProductionHistoryPage />;
      case "live-production":
        return <LiveProductionPage />;
      case "daily-production":
        return <DailyProductionPage />;
      case "daily-dispatch":
        return <DailyDispatchPage />;
      case "live-dispatch":
        return <LiveDispatchPage />;
      case "dispatch-history":
        return <DispatchHistoryPage />;
      case "live-return":
        return <LiveReturnPage />;
      case "return-history":
        return <ReturnHistoryPage />;
      case "store-home":
        return <StoreHomePage onNavigate={setRoute} />;
      // STORE IN — one page, one tab per section, the scan station down the right. Every one of
      // these routes renders the SAME element type here, unkeyed, so moving between tabs keeps
      // the component — and with it the scanner's open session — mounted.
      case "store-in-operator":
      case "store-in-new-material":
      case "store-in-qr-generator":
      case "store-in-stock":
      case "store-in-receipts":
      case "store-in-setup":
      case "store-in-manual-entry":
      case "store-in-daily-report":
        return (
          <StoreInPage
            tab={storeInTabOfRoute(route)}
            token={sessionToken ?? ""}
            username={session.username}
            isAdmin={session.role === USER_ROLE.ADMIN}
            access={{
              stock: hasPermission(session, PERMISSION.STOCK),
              labels: hasPermission(session, PERMISSION.RAW_MATERIAL_QR_GENERATOR),
              settings:
                hasPermission(session, PERMISSION.SETTINGS) || hasPermission(session, PERMISSION.RAW_MATERIAL_SETUP),
              report: hasPermission(session, PERMISSION.STORE_SCANNING),
              manual: hasPermission(session, PERMISSION.STORE_SCANNING),
            }}
            onNavigate={setRoute}
          />
        );
      case "store-in-scanner":
        return (
          <RawMaterialInputPage
            token={sessionToken ?? ""}
            username={session.username}
            onBack={() => setRoute("store-in-operator")}
          />
        );
      // THE STORE PAGE (0.3.9): both modes render the SAME element, unkeyed, so switching mode keeps
      // the page — and both scan stations with their sessions — mounted.
      case "store-receiving":
      case "store-issuing":
        return (
          <StorePage
            mode={storeModeOfRoute(route)}
            token={sessionToken ?? ""}
            username={session.username}
            isAdmin={session.role === USER_ROLE.ADMIN}
            access={{
              stock: hasPermission(session, PERMISSION.STOCK),
              labels: hasPermission(session, PERMISSION.RAW_MATERIAL_QR_GENERATOR),
              settings: hasPermission(session, PERMISSION.SETTINGS) || hasPermission(session, PERMISSION.RAW_MATERIAL_SETUP),
            }}
            onModeChange={(next) => setRoute(STORE_MODE_ROUTE[next])}
            onNavigate={setRoute}
          />
        );
      case "store-out-operator":
        return (
          <StoreOutPage
            token={sessionToken ?? ""}
            username={session.username}
            onBack={() => setRoute("store-home")}
            onOpenReport={() => setRoute("store-out-daily-report")}
            onOpenQrGenerator={canOpenRoute(session, "qr-generator") ? () => setRoute("qr-generator") : undefined}
            initialProgramId={storeOutProgramId}
            onInitialProgramConsumed={() => setStoreOutProgramId(undefined)}
          />
        );
      case "store-out-daily-report":
        return <StoreOutReportPage token={sessionToken ?? ""} onBack={() => setRoute("store-out-operator")} />;
      // The Munshi's station, and the raw material Stock section opened from it. Stock is the
      // store's own workspace section — the same component, the same data, the same checks —
      // with the Munshi's way back instead of the Move In operator's.
      case "munshi-home":
        return (
          <MunshiHomePage
            onNavigate={setRoute}
            access={{
              gatepass: hasPermission(session, PERMISSION.GATEPASS),
              stock: hasPermission(session, PERMISSION.STOCK),
            }}
          />
        );
      case "munshi-stock":
        return (
          <StoreWorkspacePage
            key={route}
            tab="stock"
            username={session.username}
            isAdmin={session.role === USER_ROLE.ADMIN}
            canPrintLabels={hasPermission(session, PERMISSION.RAW_MATERIAL_QR_GENERATOR)}
            backLabel={copy.munshi.home}
            stationLabel={copy.munshi.role}
            onDone={() => setRoute("munshi-home")}
            onNavigate={setRoute}
          />
        );
      case "store-scanning":
        return (
          <StoreScanningPage
            token={sessionToken ?? ""}
            username={session.username}
            onBack={() => setRoute("store-home")}
          />
        );
      case "store-move-out":
        return (
          <StoreMoveOutPage
            token={sessionToken ?? ""}
            username={session.username}
            onBack={() => setRoute("store-home")}
          />
        );
      case "gatepass":
        return (
          <GatepassPage
            token={sessionToken ?? ""}
            username={session.username}
            onNavigate={navigateTo}
          />
        );
      case "gatepass-list":
        return (
          <GatepassListPage
            token={sessionToken ?? ""}
            username={session.username}
            canCancel={hasPermission(session, PERMISSION.GATEPASS_CANCEL)}
            permissions={session.permissions ?? []}
            isAdmin={session.role === "ADMIN"}
            initialGatepassId={selectedProductId}
            onNavigate={navigateTo}
          />
        );
      // The two scanning desks: the same screen, one route each so each can be permissioned
      // separately. Which Gatepass is being scanned travels in the same id the list uses.
      case "gatepass-store-scan":
      case "gatepass-dispatch-scan":
        return (
          <GatepassScanPage
            gatepassId={selectedProductId ?? ""}
            desk={route === "gatepass-store-scan" ? "STORE" : "DISPATCH"}
            token={sessionToken ?? ""}
            username={session.username}
            onBack={() => setRoute("gatepass-list")}
          />
        );
      case "party-list":
        return (
          <PartyListPage
            onNavigate={navigateToParty}
          />
        );
      case "party-form":
        return (
          <PartyFormPage
            partyId={selectedPartyId}
            onNavigate={leavePartyForm}
          />
        );
      case "customer-ledger":
        return (
          <CustomerLedgerPage
            onNavigate={navigateTo}
          />
        );
      case "customer-balance":
        return <CustomerBalancePage onNavigate={setRoute} />;
      case "product-list":
        return (
          <ProductListPage
            onNavigate={navigateTo}
          />
        );
      case "product-form":
        return (
          <ProductFormPage
            productId={selectedProductId}
            onNavigate={leaveForm}
          />
        );
      case "product-lists":
        return <ProductListsPage username={session.username} />;
      // Carton QRs and B-Carton Labels: two tabs of one workspace, each run for a chosen machine.
      // b-carton-generator is a deep link onto the B tab, so its permission keeps gating it.
      case "qr-generator":
      case "b-carton-generator":
        return (
          <QrGeneratorWorkspace
            key={route}
            username={session.username}
            initialTab={route === "b-carton-generator" ? "b-cartons" : reconcileProgramId ? "reconcile" : undefined}
            reconcileProgramId={reconcileProgramId}
            onNavigate={setRoute}
            onSetUpMachines={canOpenRoute(session, "machine-program") ? () => setRoute("machine-program") : undefined}
            canReceiveProduction={canOpenRoute(session, "live-production")}
            canUpperMoveOut={canOpenRoute(session, "raw-material-output")}
            canMachineProgram={canOpenRoute(session, "machine-program")}
          />
        );
      case "qr-management":
        return <QrManagementPage username={session.username} />;
      case "qr-journey":
        return <QrJourneyPage username={session.username} />;
      case "discount-policy":
        return <DiscountPolicyPage />;
      case "sale-voucher-form":
        return (
          <SaleVoucherFormPage
            voucherId={selectedProductId}
            fromGatepassId={saleVoucherGatepassId}
            token={sessionToken ?? ""}
            onNavigate={leaveForm}
          />
        );
      case "sale-voucher-list":
        return <SaleVoucherListPage onNavigate={navigateTo} />;
      case "cash-voucher-list":
        return (
          <CashVoucherListPage
            onNavigate={navigateTo}
          />
        );
      case "cash-voucher-form":
        return (
          <CashVoucherFormPage
            voucherId={selectedProductId}
            onNavigate={leaveForm}
          />
        );
      case "purchase-voucher-list":
        return (
          <PurchaseVoucherListPage
            onNavigate={navigateTo}
          />
        );
      case "purchase-voucher-form":
        return (
          <PurchaseVoucherFormPage
            voucherId={selectedProductId}
            onNavigate={leaveForm}
          />
        );
      case "supplier-ledger":
        return (
          <SupplierLedgerPage
            onNavigate={navigateTo}
          />
        );
      case "supplier-balance":
        return <SupplierBalancePage onNavigate={setRoute} />;
      case "contractor-ledger":
        return <ContractorLedgerPage onNavigate={navigateTo} />;
      case "settings":
        return <SettingsPage isAdmin={session.role === USER_ROLE.ADMIN} />;
      case "health":
        return <HealthPage />;
      case "logs":
        return <LogsPage />;
      case "workspace":
        return (
          <WorkspacePage
            api={api}
            token={sessionToken ?? ""}
            initialTab={workspaceTab}
          />
        );
      default:
        return home;
    }
  }, [
    admin.members,
    admin.roleOptions,
    admin.roles,
    auth,
    authError,
    authSuccess,
    authView,
    isAddingAccount,
    needsBootstrap,
    leaveForm,
    leavePartyForm,
    navigateTo,
    navigateToParty,
    requestStatus,
    route,
    saleVoucherGatepassId,
    selectedPartyId,
    selectedProductId,
    session,
    sessionToken,
    storeOutProgramId,
    workspaceTab,
  ]);

  return (
    <SessionProvider user={session} token={sessionToken}>
      <div className="app-shell">
        {session && showNavbar && !isAddingAccount && (
          <Navbar
            current={route}
            onSelect={setRoute}
            appVersion={appVersion}
            onBackup={onBackup}
            user={session}
            storeJob={storeJob}
            onProfile={() => setRoute("profile")}
            onChangePassword={() => setRoute("change-password")}
            onLogout={auth.handleLogout}
            accessRequests={admin.accessRequests}
            onReviewAccessRequest={admin.handleReviewAccessRequest}
            notifications={admin.userNotifications}
            onNotificationClick={onNotificationClick}
            roleOptions={admin.roleOptions}
            permissionRequests={admin.permissionRequests}
            onReviewPermissionRequest={admin.handleReviewPermissionRequest}
            savedProfiles={savedProfiles}
            onSwitchProfile={auth.handleSwitchProfile}
            onAddAccount={auth.handleAddAccount}
          />
        )}

        {session && !showNavbar && !isAddingAccount && (
          <FloatingProfileMenu
            user={session}
            savedProfiles={savedProfiles}
            onSwitchProfile={auth.handleSwitchProfile}
            onAddAccount={auth.handleAddAccount}
            onLogout={auth.handleLogout}
            onChangePassword={() => setRoute("change-password")}
            onProfile={() => setRoute("profile")}
          />
        )}

        <main className={`page-content${!showNavbar || FULLSCREEN_ROUTES.has(route) ? " page-content--fullscreen" : ""}`}>
          {content}
        </main>

        <NotificationCenter />
      </div>
    </SessionProvider>
  );
};
