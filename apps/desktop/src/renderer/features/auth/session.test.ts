import { describe, expect, it } from "vitest";
import { HOME_ROUTE, canOpenRoute, isStoreOperator, landingRoute } from "./session";
import type { AuthUser } from "../../types/desktopApi";

const user = (
  permissions: string[],
  role: AuthUser["role"] = "USER",
  accessStatus: AuthUser["accessStatus"] = "APPROVED"
): AuthUser => ({
  id: "u-1",
  username: "aslam",
  role,
  accessStatus,
  permissions,
  lastLoginAt: null,
});

describe("landingRoute — the first screen after signing in", () => {
  it("starts a store operator on the Store page, in Receiving (0.3.9)", () => {
    expect(landingRoute(user(["store-scanning"]))).toBe("store-receiving");
    expect(landingRoute(user(["store-scanning", "stock", "raw-material-qr-generator"]))).toBe("store-receiving");
  });

  it("starts everyone else on their Dashboard", () => {
    expect(landingRoute(user(["munshi", "gatepass"]))).toBe(HOME_ROUTE);
    expect(landingRoute(user([]))).toBe(HOME_ROUTE);
    expect(landingRoute(null)).toBe(HOME_ROUTE);
  });

  it("starts an administrator on the Dashboard, though they hold every permission", () => {
    expect(landingRoute(user([], "ADMIN"))).toBe(HOME_ROUTE);
  });

  it("does not count a person still waiting as a store operator, though their saved role grants Store Scanning", () => {
    // Counted as one, the waiting screen hid every way to sign out (rehearsal, 2 Nov).
    expect(landingRoute(user(["store-scanning"], "USER", "PENDING"))).toBe(HOME_ROUTE);
    expect(landingRoute(user(["store-scanning"], "USER", "REJECTED"))).toBe(HOME_ROUTE);
    expect(isStoreOperator(user(["store-scanning"], "USER", "PENDING"))).toBe(false);
  });
});

describe("canOpenRoute — the carton QR Generator (0.3.6)", () => {
  const routes = ["qr-generator", "b-carton-generator"] as const;

  it("opens for a store operator, who holds no QR Generator permission of their own", () => {
    for (const route of routes) expect(canOpenRoute(user(["store-scanning"]), route)).toBe(true);
  });

  it("still opens for anyone given QR Generator, as before", () => {
    for (const route of routes) expect(canOpenRoute(user(["qr-generator"]), route)).toBe(true);
  });

  it("stays closed to someone with neither", () => {
    for (const route of routes) expect(canOpenRoute(user(["stock", "gatepass"]), route)).toBe(false);
  });
});
