import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { NotificationsProvider } from "../state/NotificationsContext";
import { SaleVoucherFormPage } from "../pages/SaleVoucherFormPage";

beforeAll(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});

// In-memory stand-in for the main process's encrypted session store. Like the real one it
// survives across renders within this file, so a test that signs in leaves later tests
// signed in (the shell restores the active session on boot).
type StoredProfile = { id: string; username: string; token: string; role: "USER" | "ADMIN"; lastUsedAt?: string };
const sessionStoreState: { activeToken: string | null; profiles: StoredProfile[] } = { activeToken: null, profiles: [] };
const snapshotSessionStore = () => ({ activeToken: sessionStoreState.activeToken, profiles: [...sessionStoreState.profiles] });
const makeSessionStore = () => ({
  load: vi.fn(async () => snapshotSessionStore()),
  save: vi.fn(async (profile: StoredProfile) => {
    sessionStoreState.activeToken = profile.token;
    sessionStoreState.profiles = [profile, ...sessionStoreState.profiles.filter((item) => item.token !== profile.token)];
    return snapshotSessionStore();
  }),
  remove: vi.fn(async (token: string) => {
    if (sessionStoreState.activeToken === token) sessionStoreState.activeToken = null;
    sessionStoreState.profiles = sessionStoreState.profiles.filter((item) => item.token !== token);
    return snapshotSessionStore();
  }),
  clear: vi.fn(async () => {
    sessionStoreState.activeToken = null;
    return snapshotSessionStore();
  }),
});

const makeApi = () => ({
  getRuntime: vi.fn().mockResolvedValue({ dbPath: "C:/tmp/db.sqlite", appVersion: "0.1.0" }),
  sessionStore: makeSessionStore(),
  hasAnyAdmin: vi.fn().mockResolvedValue({ hasAdmin: true }),
  bootstrapAdmin: vi.fn().mockResolvedValue({ accepted: true, user: { id: "admin-1", username: "owner", role: "ADMIN", accessStatus: "APPROVED" } }),
  getSession: vi.fn().mockResolvedValue({ id: "u-1", username: "mama", role: "ADMIN", accessStatus: "APPROVED", permissions: ["*"] }),
  signIn: vi.fn().mockResolvedValue({ accepted: true, user: { id: "u-1", username: "mama", role: "ADMIN", accessStatus: "APPROVED" } }),
  signUp: vi.fn().mockResolvedValue({ accepted: true, user: { id: "u-1", username: "mama" } }),
  changePassword: vi.fn().mockResolvedValue({ accepted: true }),
  logout: vi.fn().mockResolvedValue({ accepted: true }),
  requestAccess: vi.fn().mockResolvedValue({ accepted: true, status: "PENDING" }),
  getMyAccessRequest: vi.fn().mockResolvedValue({ accepted: true, request: null }),
  getDashboard: vi.fn().mockResolvedValue({
    todaysProduction: 10,
    currentStockTotal: 40,
    inventoryValue: 1200,
    syncQueuePending: 2,
    productionCounter: 10,
    recentScans: [],
    byHour: [],
    byProduct: [],
    byColor: [],
    bySize: []
  }),
  listInventory: vi.fn().mockResolvedValue([]),
  listProducts: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 100 }),
  getParty: vi.fn().mockResolvedValue({ id: "p-1", partyName: "ABC Traders", partyType: "CUSTOMER", status: "ACTIVE", createdAt: "2024-01-01" }),
  getCustomerLedgerWithCash: vi.fn().mockResolvedValue({ closingBalance: 0 }),
  getSaleableVariant: vi.fn().mockResolvedValue({ id: "prod-1", article: "SK30", color: "Blue", size: "M", sellingPrice: 150, stockQuantity: 14, articleSeriesId: null, productGroupId: null }),
  listParties: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 100 }),
  listSaleVouchers: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 100 }),
  createProduct: vi.fn().mockResolvedValue("id-1"),
  updateProduct: vi.fn().mockResolvedValue(undefined),
  disableProduct: vi.fn().mockResolvedValue(undefined),
  listHistory: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 50 }),
  listDispatchHistory: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 50 }),
  listDispatchSessions: vi.fn().mockResolvedValue([]),
  getDispatchSession: vi.fn().mockResolvedValue(null),
  getScannerStatus: vi.fn().mockResolvedValue(true),
  dispatchScan: vi.fn().mockResolvedValue({ accepted: true, qrId: "SK6_BLUE_7/10_001", parserVersion: "v1" }),
  getReport: vi.fn().mockResolvedValue({
    totalProduction: 10,
    inventoryValue: 1200,
    byArticle: [],
    byColor: [],
    bySize: [],
    byHour: [],
    topProducts: []
  }),
  processScan: vi.fn().mockResolvedValue({ accepted: true, qrId: "SK6_BLUE_7/10_001", parserVersion: "v1" }),
  getSettings: vi.fn().mockResolvedValue({ theme: "light" }),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  createBackup: vi.fn().mockResolvedValue({ backupPath: "C:/tmp/backup.sqlite" }),
  listBackups: vi.fn().mockResolvedValue([]),
  getHealth: vi.fn().mockResolvedValue({
    sqliteStatus: "OK",
    databaseSizeBytes: 100,
    pendingSyncQueue: 1,
    failedSyncQueue: 0,
    scannerConnected: true,
    diskFreeBytes: 100,
    memoryUsageBytes: 10,
    cpuLoadAverage: 0,
    backupStatus: "NONE",
    appVersion: "0.1.0",
    deviceId: "desktop-main",
    moneyDrift: { healthy: true, pairsChecked: 2, violationCount: 0, violations: [] }
  }),
  getLogs: vi.fn().mockResolvedValue([]),
  getAccessRequests: vi.fn().mockResolvedValue({ accepted: true, requests: [] }),
  reviewAccessRequest: vi.fn().mockResolvedValue({ accepted: true }),
  listAuditLogs: vi.fn().mockResolvedValue({ accepted: true, logs: [] }),
  listUniqueArticles: vi.fn().mockResolvedValue([]),
  listUniqueSizesByArticle: vi.fn().mockResolvedValue([]),
  listUniqueColorsByArticle: vi.fn().mockResolvedValue([]),
  listMainGroups: vi.fn().mockResolvedValue([]),
  listProductGroups: vi.fn().mockResolvedValue([]),
  listArticleSeries: vi.fn().mockResolvedValue([]),
  getProductImage: vi.fn().mockResolvedValue(null),
  saveProductImage: vi.fn().mockResolvedValue({ accepted: true, fileName: "SK6.png" }),
  resolveProductDiscount: vi.fn().mockResolvedValue({ discountPerPair: 0, source: "NONE" }),
  resolveProductDiscountWithPrice: vi.fn().mockResolvedValue({ discountPerPair: 0, source: "NONE" }),
});

const renderApp = (customApi?: ReturnType<typeof makeApi>) => {
  const api = customApi ?? makeApi();
  Object.defineProperty(window, "desktop", {
    value: {
      versions: { node: "22", chrome: "128", electron: "43" },
      api
    },
    configurable: true
  });

  render(
    <NotificationsProvider>
      <App />
    </NotificationsProvider>
  );

  return api;
};

describe("App", () => {
  it("shows the Create Administrator screen when no admin account exists yet", async () => {
    const api = makeApi();
    api.hasAnyAdmin.mockResolvedValue({ hasAdmin: false });
    renderApp(api);

    expect(await screen.findByRole("heading", { name: /create administrator/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Login" })).not.toBeInTheDocument();
  });

  it("creates the first administrator from the bootstrap screen and signs them in", async () => {
    const api = makeApi();
    api.hasAnyAdmin.mockResolvedValue({ hasAdmin: false });
    api.bootstrapAdmin.mockResolvedValue({
      accepted: true,
      user: { id: "admin-1", username: "owner", role: "ADMIN", accessStatus: "APPROVED", permissions: ["dashboard", "navbar"] },
      token: "tok-bootstrap-1",
    });
    renderApp(api);

    await screen.findByRole("heading", { name: /create administrator/i });
    await userEvent.type(screen.getByLabelText("Username"), "owner");
    await userEvent.type(screen.getByLabelText("Password"), "Password123");
    await userEvent.type(screen.getByLabelText("Confirm password"), "Password123");
    await userEvent.click(screen.getByRole("button", { name: /create administrator/i }));

    expect(api.bootstrapAdmin).toHaveBeenCalledWith("owner", "Password123", "Password123");
    // Signed in as the new admin: the bootstrap screen is gone and the shell shows their name.
    // (Not asserting on Dashboard content here — that route is currently hidden by
    // visibleSections.ts for every signed-in user, a pre-existing, unrelated condition.)
    expect(await screen.findByText("owner")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /create administrator/i })).not.toBeInTheDocument();
  });

  it("renders login when no active session exists", async () => {
    const api = makeApi();
    api.getSession.mockResolvedValue(null);
    renderApp(api);
    expect(await screen.findByRole("heading", { name: "Login" })).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("signs in an authenticated user and shows the ERP shell", async () => {
    const api = makeApi();
    api.getSession.mockResolvedValue(null);
    renderApp(api);
    api.signIn.mockResolvedValueOnce({ accepted: true, user: { id: "u-1", username: "mama", role: "ADMIN", permissions: ["dashboard", "navbar"] } });
    await userEvent.type(screen.getByLabelText(/username/i), "mama");
    await userEvent.type(screen.getByLabelText(/password/i), "Password123");
    await userEvent.click(screen.getByRole("button", { name: /login/i }));

    // Every role lands on its Dashboard, titled with the role — an admin with none is "Administrator".
    expect(await screen.findByRole("heading", { name: "Administrator" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /main navigation/i })).toBeInTheDocument();
  });

  it("starts a store operator on the Store page in Receiving, with one sidebar row, and Escape stays there (0.3.9)", async () => {
    const api = makeApi();
    api.getSession.mockResolvedValue(null);
    renderApp(api);
    api.signIn.mockResolvedValueOnce({
      accepted: true,
      user: { id: "u-3", username: "store-op", role: "USER", accessStatus: "APPROVED", permissions: ["store-scanning"] },
    });
    await userEvent.type(screen.getByLabelText(/username/i), "store-op");
    await userEvent.type(screen.getByLabelText(/password/i), "Password123");
    await userEvent.click(screen.getByRole("button", { name: /login/i }));

    expect(await screen.findByRole("heading", { level: 1, name: "Store" })).toBeInTheDocument();
    const modes = screen.getByRole("group", { name: "What the store is doing" });
    expect(within(modes).getByRole("button", { name: /Receiving/ })).toHaveAttribute("aria-pressed", "true");

    // The sidebar is one row: Store.
    const rail = screen.getByRole("navigation", { name: /main navigation/i });
    expect(within(rail).getAllByRole("button").map((button) => button.textContent)).toEqual(["Store"]);

    // Issuing, then Escape: the page stays on Issuing — Escape never switches mode.
    await userEvent.click(within(modes).getByRole("button", { name: /Issuing/ }));
    await userEvent.keyboard("{Escape}");
    expect(within(screen.getByRole("group", { name: "What the store is doing" })).getByRole("button", { name: /Issuing/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("creates an access request from the Rookie screen", async () => {
    const api = makeApi();
    api.getSession.mockResolvedValue(null);
    renderApp(api);
    api.signIn.mockResolvedValueOnce({
      accepted: true,
      user: { id: "u-2", username: "rookie", role: "USER", accessStatus: "PENDING", permissions: [], lastLoginAt: null },
      token: "rookie-token",
    });

    await userEvent.type(screen.getByLabelText(/username/i), "rookie");
    await userEvent.type(screen.getByLabelText(/password/i), "Password123");
    await userEvent.click(screen.getByRole("button", { name: /login/i }));
    const requestButton = await screen.findByRole("button", { name: "Request Access" });
    await userEvent.click(requestButton);

    await waitFor(() => expect(api.requestAccess).toHaveBeenCalledWith("rookie-token"));
    expect(await screen.findByRole("status")).toHaveTextContent("Request Sent");
  });

  it("renders dashboard", async () => {
    renderApp();
    // Home first; the KPI overview is one of its tiles.
    await userEvent.click(await screen.findByTestId("nav-tile-dashboard"));
    expect(await screen.findByText("Today's Production")).toBeInTheDocument();
    expect(await screen.findAllByText("Current Stock")).not.toHaveLength(0);
  });

  it("renders production page via keyboard shortcut", async () => {
    renderApp();
    await userEvent.keyboard("{F2}");
    expect(await screen.findByText("Live Production Terminal")).toBeInTheDocument();
    expect(await screen.findByText("Recent Activity")).toBeInTheDocument();
  });

  it("opens the dispatch scanner immediately when a pending bill is selected", async () => {
    const api = makeApi();
    api.listDispatchSessions.mockResolvedValue([
      {
        sessionId: "s-1",
        voucherId: "v-1",
        voucherNumber: "INV-1001",
        partyName: "Mama Chappal Karachi",
        voucherDate: "2026-08-15",
        totalQuantity: 12,
        totalAmount: 2000,
        status: "PENDING",
        startedAt: "2026-08-15T10:00:00.000Z",
        remainingCartons: 2,
        remainingPairs: 12
      }
    ]);

    Object.defineProperty(window, "desktop", {
      value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
      configurable: true
    });

    render(
      <NotificationsProvider>
        <App />
      </NotificationsProvider>
    );

    // F6 → live-dispatch page
    await userEvent.keyboard("{F6}");

    const billButton = await screen.findByRole("button", { name: /Mama Chappal Karachi/i });
    await userEvent.click(billButton);

    // Clicking a pending bill opens the scan overlay
    expect(await screen.findByText("READY TO SCAN")).toBeInTheDocument();
  });

  it("reloads bill progress immediately after a successful dispatch scan", async () => {
    const api = makeApi();
    const baseSession = {
      sessionId: "s-1",
      voucherId: "v-1",
      voucherNumber: "INV-1001",
      partyName: "Mama Chappal Karachi",
      voucherDate: "2026-08-15",
      status: "IN_PROGRESS",
      allowedItems: [{
        lineItemId: "li-1",
        productVariantId: "pv-1",
        article: "SK7",
        color: "RED",
        size: "7/10",
        requiredDzn: 15,
        requiredCartons: 30,
        dispatchedCartons: 0,
        requiredPairs: 180,
        dispatchedPairs: 0,
      }],
    };
    const afterScanSession = {
      ...baseSession,
      allowedItems: [{
        ...baseSession.allowedItems[0],
        dispatchedCartons: 1,
        dispatchedPairs: 6,
      }],
    };

    api.listDispatchSessions.mockResolvedValue([
      {
        sessionId: "s-1",
        voucherId: "v-1",
        voucherNumber: "INV-1001",
        partyName: "Mama Chappal Karachi",
        voucherDate: "2026-08-15",
        totalQuantity: 15,
        totalAmount: 2000,
        status: "IN_PROGRESS",
        startedAt: "2026-08-15T10:00:00.000Z",
        remainingCartons: 30,
        remainingPairs: 180,
      }
    ]);
    api.getDispatchSession.mockResolvedValueOnce(baseSession).mockResolvedValueOnce(afterScanSession);
    api.dispatchScan.mockResolvedValueOnce({ accepted: true, qrId: "SK7_RED_7/10_001", parserVersion: "v1" });

    Object.defineProperty(window, "desktop", {
      value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
      configurable: true
    });

    render(
      <NotificationsProvider>
        <App />
      </NotificationsProvider>
    );

    await userEvent.keyboard("{F6}");
    const billButton = await screen.findByRole("button", { name: /Mama Chappal Karachi/i });
    await userEvent.click(billButton);

    const input = await screen.findByPlaceholderText(/scan item qr code/i);
    await userEvent.type(input, "SK7_RED_7/10_001");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(api.dispatchScan).toHaveBeenCalledWith("SK7_RED_7/10_001", "s-1"));
    await waitFor(() => expect(api.getDispatchSession).toHaveBeenCalledTimes(2));
    // 15 dozen = 30 cartons; one carton scanned leaves 29 pending. Progress is in cartons, never pairs.
    expect((await screen.findAllByText("29")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("30").length).toBeGreaterThan(0);
    expect(screen.queryByText("180")).not.toBeInTheDocument();
    expect(screen.queryByText("179")).not.toBeInTheDocument();
  });

  it("shows scan success", async () => {
    const api = renderApp();
    await userEvent.keyboard("{F2}");
    const input = await screen.findByPlaceholderText(/waiting for scan/i);
    await userEvent.type(input, "SK6_BLUE_7/10_001");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(api.processScan).toHaveBeenCalled());
    expect(await screen.findByText("Unit Recorded Successfully")).toBeInTheDocument();
  });

  it("shows scan error", async () => {
    const api = renderApp();
    api.processScan.mockResolvedValueOnce({ accepted: false, reason: "This QR has already been produced." });
    await userEvent.keyboard("{F2}");
    const input = await screen.findByPlaceholderText(/waiting for scan/i);
    await userEvent.type(input, "SK6_BLUE_7/10_001");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(api.processScan).toHaveBeenCalled());
    expect(await screen.findByText("Duplicate Scan")).toBeInTheDocument();
  });

  it("records a first scan even when the ArticleSize was not pre-created", async () => {
    const api = renderApp();
    api.processScan.mockResolvedValueOnce({ accepted: true, qrId: "SK6_GREEN_7/10_00001", parserVersion: "v1" });
    await userEvent.keyboard("{F2}");
    const input = await screen.findByPlaceholderText(/waiting for scan/i);
    await userEvent.type(input, "SK6_GREEN_7/10_00001");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("Unit Recorded Successfully")).toBeInTheDocument();
  });

  it("shows Invalid QR Format for malformed scan results", async () => {
    const api = renderApp();
    api.processScan.mockResolvedValueOnce({ accepted: false, reason: "QR_UNSUPPORTED_FORMAT: invalid QR" });
    await userEvent.keyboard("{F2}");
    const input = await screen.findByPlaceholderText(/waiting for scan/i);
    await userEvent.type(input, "BAD_INPUT");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("INVALID FORMAT")).toBeInTheDocument();
  });

  it("shows Backup button in navbar", async () => {
    renderApp();
    expect(await screen.findByRole("button", { name: /backup/i })).toBeInTheDocument();
  });

  it("shows a party dropdown and product selector for sale vouchers", async () => {
    const api = {
      ...makeApi(),
      listParties: vi.fn().mockResolvedValue({ rows: [{ id: "p-1", partyName: "ABC Traders", partyType: "CUSTOMER", status: "ACTIVE", createdAt: "2024-01-01" }], total: 1, page: 1, pageSize: 100 }),
      listProducts: vi.fn().mockResolvedValue({ rows: [{ id: "prod-1", article: "SK30", color: "Blue", size: "M", description: null, costPrice: 100, sellingPrice: 150, mainGroupId: null, groupId: null, status: "ACTIVE", createdAt: "2024-01-01", updatedAt: "2024-01-01" }], total: 1, page: 1, pageSize: 100 }),
      listInventory: vi.fn().mockResolvedValue([{ productId: "prod-1", article: "SK30", color: "Blue", size: "M", quantity: 14, costPrice: 100, sellingPrice: 150, stockValue: 1400, potentialRevenue: 2100, profitPotential: 700 }]),
      listSaleVouchers: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 100 })
    };

    Object.defineProperty(window, "desktop", {
      value: {
        versions: { node: "22", chrome: "128", electron: "43" },
        api
      },
      configurable: true
    });

    render(
      <NotificationsProvider>
        <SaleVoucherFormPage onNavigate={() => undefined} />
      </NotificationsProvider>
    );

    // Party dropdown has aria label via htmlFor="sv-party"
    expect(await screen.findByRole("combobox", { name: /party/i })).toBeInTheDocument();
    // Product dropdown is the second combobox on the page
    expect(screen.getAllByRole("combobox").length).toBeGreaterThanOrEqual(2);
    // Voucher number shown prominently as a number
    expect(await screen.findByText("1")).toBeInTheDocument();
    // Add Item section present
    expect(await screen.findByText(/Add Item/i)).toBeInTheDocument();
  });

  it("prefills product rate and party discount when a single-color product is selected for a party", async () => {
    const api = {
      ...makeApi(),
      listParties: vi.fn().mockResolvedValue({ rows: [{ id: "p-1", partyName: "ABC Traders", partyType: "CUSTOMER", status: "ACTIVE", createdAt: "2024-01-01" }], total: 1, page: 1, pageSize: 100 }),
      listProducts: vi.fn().mockResolvedValue({ rows: [{ id: "prod-1", article: "SK30", color: "Blue", size: "M", description: null, costPrice: 100, sellingPrice: 150, mainGroupId: null, groupId: null, status: "ACTIVE", createdAt: "2024-01-01", updatedAt: "2024-01-01" }], total: 1, page: 1, pageSize: 100 }),
      listInventory: vi.fn().mockResolvedValue([{ productId: "prod-1", article: "SK30", color: "Blue", size: "M", quantity: 14, costPrice: 100, sellingPrice: 150, stockValue: 1400, potentialRevenue: 2100, profitPotential: 700 }]),
      resolveProductDiscount: vi.fn().mockResolvedValue({ discountPerPair: 35, source: "ARTICLE" }),
      resolveProductDiscountWithPrice: vi.fn().mockResolvedValue({ discountPerPair: 35, source: "ARTICLE" }),
      listSaleVouchers: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 100 })
    };

    Object.defineProperty(window, "desktop", {
      value: {
        versions: { node: "22", chrome: "128", electron: "43" },
        api
      },
      configurable: true
    });

    render(
      <NotificationsProvider>
        <SaleVoucherFormPage onNavigate={() => undefined} />
      </NotificationsProvider>
    );

    const partySelect = await screen.findByRole("combobox", { name: /party/i });
    await userEvent.selectOptions(partySelect, "p-1");

    // Product dropdown is the second combobox
    const productSelect = screen.getAllByRole("combobox")[1];
    await userEvent.selectOptions(productSelect, "prod-1");

    // Single-color product: auto-selects color and calls the price-aware resolver
    await waitFor(() => expect(api.resolveProductDiscountWithPrice).toHaveBeenCalledWith("p-1", "prod-1", 150));
    // Rate field should be prefilled with sellingPrice=150
    await waitFor(() => expect(screen.getByDisplayValue("150")).toBeInTheDocument());
    // Discount field should be prefilled with discountPerPair=35
    await waitFor(() => expect(screen.getByDisplayValue("35")).toBeInTheDocument());
  });

  it("creates sequential vouchers and returns to the previous voucher from the blank next form", async () => {
    const api = {
      ...makeApi(),
      listParties: vi.fn().mockResolvedValue({ rows: [{ id: "p-1", partyName: "ABC Traders", partyType: "CUSTOMER", status: "ACTIVE", createdAt: "2024-01-01" }], total: 1, page: 1, pageSize: 100 }),
      listProducts: vi.fn().mockResolvedValue({
        rows: [{ id: "prod-1", article: "SK30", color: "Blue", size: "M", description: null, costPrice: 100, sellingPrice: 150, mainGroupId: null, groupId: null, status: "ACTIVE", createdAt: "2024-01-01", updatedAt: "2024-01-01" }],
        total: 1, page: 1, pageSize: 100
      }),
      listInventory: vi.fn().mockResolvedValue([
        { productId: "prod-1", article: "SK30", color: "Blue", size: "M", quantity: 14, costPrice: 100, sellingPrice: 150, stockValue: 1400, potentialRevenue: 2100, profitPotential: 700 }
      ]),
      // first call = mount (no vouchers yet), second call = after save (voucher list updated)
      listSaleVouchers: vi.fn()
        .mockResolvedValueOnce({ rows: [], total: 0, page: 1, pageSize: 100 })
        .mockResolvedValue({ rows: [{ id: "v-1", voucherNumber: "1", partyName: "ABC Traders", voucherDate: "2026-08-15", bookNo: "", subPartyName: null, totalQuantity: 2, totalAmount: 300, status: "DRAFT", createdAt: "2026-08-15" }], total: 1, page: 1, pageSize: 100 }),
      createSaleVoucher: vi.fn().mockResolvedValue({ accepted: true, id: "v-1", voucherNumber: "1" }),
      addVoucherLineItem: vi.fn().mockResolvedValue({ accepted: true, id: "li-1" }),
      getSaleVoucher: vi.fn().mockResolvedValue({
        id: "v-1", voucherNumber: "1", partyId: "p-1", partyName: "ABC Traders",
        voucherDate: "2026-08-15", bookNo: "", subPartyName: null, subPartyNumber: null, remarks: null,
        totalQuantity: 2, totalAmount: 300, status: "DRAFT",
        lineItems: [{ id: "li-1", productVariantId: "prod-1", quantity: 2, priceType: "NORMAL" as const, unitPrice: 150, discount: 0, discountPerPair: 0, discountSource: "NONE" as const, totalPrice: 300, article: "SK30", color: "Blue", size: "M" }],
        createdAt: "2026-08-15", updatedAt: "2026-08-15"
      }),
      updateSaleVoucher: vi.fn().mockResolvedValue({ accepted: true }),
      deleteVoucherLineItem: vi.fn().mockResolvedValue({ accepted: true }),
    };

    Object.defineProperty(window, "desktop", {
      value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
      configurable: true
    });

    render(
      <NotificationsProvider>
        <SaleVoucherFormPage onNavigate={() => undefined} />
      </NotificationsProvider>
    );

    // Wait for party dropdown to load
    const partySelect = await screen.findByRole("combobox", { name: /party/i });
    await userEvent.selectOptions(partySelect, "p-1");

    // Wait for product option to appear, then select it (single-color → auto-selects color+rate)
    const productSelect = screen.getAllByRole("combobox")[1];
    await waitFor(() => {
      const opts = Array.from((productSelect as HTMLSelectElement).options);
      expect(opts.some((o) => o.value === "prod-1")).toBe(true);
    });
    await userEvent.selectOptions(productSelect, "prod-1");

    // Wait for rate to be auto-filled (150 from inventory)
    await waitFor(() => expect(screen.getByDisplayValue("150")).toBeInTheDocument());

    // Type qty and press Enter to add item
    const qtyInputs = screen.getAllByPlaceholderText("Qty");
    await userEvent.clear(qtyInputs[0]);
    await userEvent.type(qtyInputs[0], "2");
    await userEvent.keyboard("{Enter}");

    // Item should appear in table
    await waitFor(() => expect(screen.getAllByText("SK30").length).toBeGreaterThan(0));

    // Save the voucher
    await userEvent.click(screen.getAllByRole("button", { name: /create voucher/i })[0]);
    await waitFor(() => expect(api.createSaleVoucher).toHaveBeenCalledTimes(1));
    expect(api.createSaleVoucher.mock.calls[0][0]).toMatchObject({ partyId: "p-1" });

    // After save: next voucher number "2" shown
    await waitFor(() => expect(screen.getByText("2")).toBeInTheDocument());

    // Navigate back to voucher #1
    await userEvent.click(screen.getByRole("button", { name: /← Prev/i }));
    await waitFor(() => expect(api.getSaleVoucher).toHaveBeenCalledWith("v-1"));
  });

  it("updates color stock breakdown when selecting different products", async () => {
    // The component deduplicates products by article+size, using the first variant's id as option value.
    // So "prod-a" is the option value for SK30 M, and "prod-b" for SK40 L.
    const productA = { id: "prod-a", article: "SK30", color: "Blue", size: "M", description: null, costPrice: 100, sellingPrice: 150, mainGroupId: null, groupId: null, status: "ACTIVE", createdAt: "2024-01-01", updatedAt: "2024-01-01" };
    const productB = { id: "prod-b", article: "SK40", color: "Black", size: "L", description: null, costPrice: 110, sellingPrice: 160, mainGroupId: null, groupId: null, status: "ACTIVE", createdAt: "2024-01-01", updatedAt: "2024-01-01" };
    const api = {
      ...makeApi(),
      listParties: vi.fn().mockResolvedValue({ rows: [{ id: "p-1", partyName: "ABC Traders", partyType: "CUSTOMER", status: "ACTIVE", createdAt: "2024-01-01" }], total: 1, page: 1, pageSize: 100 }),
      listProducts: vi.fn().mockResolvedValue({ rows: [productA, { ...productA, id: "prod-a-2", color: "Red" }, productB, { ...productB, id: "prod-b-2", color: "Grey" }], total: 4, page: 1, pageSize: 100 }),
      listInventory: vi.fn().mockResolvedValue([
        { productId: "prod-a", article: "SK30", color: "Blue", size: "M", quantity: 14, costPrice: 100, sellingPrice: 150, stockValue: 1400, potentialRevenue: 2100, profitPotential: 700 },
        { productId: "prod-a-2", article: "SK30", color: "Red", size: "M", quantity: 6, costPrice: 100, sellingPrice: 150, stockValue: 600, potentialRevenue: 900, profitPotential: 300 },
        { productId: "prod-b", article: "SK40", color: "Black", size: "L", quantity: 8, costPrice: 110, sellingPrice: 160, stockValue: 880, potentialRevenue: 1280, profitPotential: 400 },
        { productId: "prod-b-2", article: "SK40", color: "Grey", size: "L", quantity: 3, costPrice: 110, sellingPrice: 160, stockValue: 330, potentialRevenue: 480, profitPotential: 150 }
      ]),
      listSaleVouchers: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 100 })
    };

    Object.defineProperty(window, "desktop", {
      value: {
        versions: { node: "22", chrome: "128", electron: "43" },
        api
      },
      configurable: true
    });

    render(
      <NotificationsProvider>
        <SaleVoucherFormPage onNavigate={() => undefined} />
      </NotificationsProvider>
    );

    // Wait for products to load, then find product dropdown
    await waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThanOrEqual(2));
    const productSelect = screen.getAllByRole("combobox")[1];
    
    // Wait for prod-a option to be rendered (products async loaded)
    await waitFor(() => {
      const opts = Array.from((productSelect as HTMLSelectElement).options);
      expect(opts.some((o) => o.value === "prod-a")).toBe(true);
    });

    // Select SK30 M (prod-a is the first variant for this article+size)
    await userEvent.selectOptions(productSelect, "prod-a");
    // Stock strip shows raw pair quantities (same as Stock page)
    await waitFor(() => expect(screen.getByText(/Blue:\s*14/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Red:\s*6/)).toBeInTheDocument());

    // Select SK40 L (prod-b is the first variant for this article+size)
    await userEvent.selectOptions(productSelect, "prod-b");
    await waitFor(() => expect(screen.getByText(/Black:\s*8/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Grey:\s*3/)).toBeInTheDocument());
  });
});
