import { describe, expect, it } from "vitest";
import { HOME_ROUTE, canOpenRoute, landingRoute } from "./session";
import type { AuthUser } from "../../types/desktopApi";

const user = (permissions: string[], role: AuthUser["role"] = "USER"): AuthUser => ({
  id: "u-1",
  username: "aslam",
  role,
  accessStatus: "APPROVED",
  permissions,
  lastLoginAt: null,
});

describe("landingRoute — the first screen after signing in", () => {
  it("starts a store operator on Store Station, where they pick their job", () => {
    expect(landingRoute(user(["store-scanning"]))).toBe("store-home");
    expect(landingRoute(user(["store-scanning", "stock", "raw-material-qr-generator"]))).toBe("store-home");
  });

  it("starts everyone else on their Dashboard", () => {
    expect(landingRoute(user(["munshi", "gatepass"]))).toBe(HOME_ROUTE);
    expect(landingRoute(user([]))).toBe(HOME_ROUTE);
    expect(landingRoute(null)).toBe(HOME_ROUTE);
  });

  it("starts an administrator on the Dashboard, though they hold every permission", () => {
    expect(landingRoute(user([], "ADMIN"))).toBe(HOME_ROUTE);
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
