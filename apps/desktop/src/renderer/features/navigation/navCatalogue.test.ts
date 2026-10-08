import { describe, expect, it } from "vitest";
import { NAV_SECTIONS, visibleNavSections } from "./navCatalogue";
import { routeAnyPermission, routePermission } from "../auth/session";
import { NAV_PERMISSION_MODULES } from "../../components/layout/Navbar";
import type { AuthUser } from "../../types/desktopApi";

const user = (permissions: string[], role: AuthUser["role"] = "USER"): AuthUser => ({
  id: "u-1",
  username: "aslam",
  role,
  accessStatus: "APPROVED",
  permissions,
  lastLoginAt: null,
});

const allItems = NAV_SECTIONS.flatMap((section) => section.items);

/** Every permission code the role editor offers. */
const assignable = new Set<string>(
  NAV_PERMISSION_MODULES.flatMap((module) =>
    module.children.length > 0 ? module.children.map(([code]) => code) : [module.id]
  )
);

describe("navigation catalogue", () => {
  it("lists each page once", () => {
    const routes = allItems.map((item) => item.route);
    expect(new Set(routes).size).toBe(routes.length);
  });

  // A card with no permission behind it would appear for every user, whatever their role.
  it("puts every card behind a permission", () => {
    for (const item of allItems) {
      const gated = routePermission[item.route] !== undefined || routeAnyPermission[item.route] !== undefined;
      expect(gated, `${item.route} has no permission`).toBe(true);
    }
  });

  // Otherwise an administrator could never give a role that card.
  it("can be assigned in the role editor, card by card", () => {
    for (const item of allItems) {
      const codes = routeAnyPermission[item.route] ?? [routePermission[item.route]];
      const offered = codes.some((code) => code !== undefined && assignable.has(code));
      expect(offered, `${item.route} cannot be assigned`).toBe(true);
    }
  });

  it("no longer offers the retired navbar permission", () => {
    expect(assignable.has("navbar")).toBe(false);
  });

  it("shows a role nothing until something is assigned", () => {
    expect(visibleNavSections(user([]))).toEqual([]);
    expect(visibleNavSections(null)).toEqual([]);
  });

  it("shows an administrator every page", () => {
    const visible = visibleNavSections(user([], "ADMIN")).flatMap((section) => section.items);
    expect(visible).toHaveLength(allItems.length);
  });

  it("keeps Machine Program out of Inventory, as a page of its own", () => {
    const inventory = NAV_SECTIONS.find((section) => section.id === "inventory");
    expect(inventory?.items.some((item) => item.route === "machine-program")).toBe(false);
    const own = NAV_SECTIONS.find((section) => section.id === "machineProgram");
    expect(own?.standalone).toBe(true);
    expect(own?.items.map((item) => item.route)).toEqual(["machine-program"]);
  });

  it("shows a Munshi exactly their station and the pages they were given", () => {
    const routes = visibleNavSections(user(["munshi", "gatepass"])).flatMap((section) =>
      section.items.map((item) => item.route)
    );
    expect(routes).toEqual(["munshi-home", "gatepass", "gatepass-list"]);
  });
});
