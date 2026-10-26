import { afterEach, describe, expect, it, vi } from "vitest";

// A reload comes back to the screen it showed; a fresh start does not (resumeRoute.ts). The module
// reads sessionStorage once, when the window's code first runs, so each case loads it afresh.

const load = async () => {
  vi.resetModules();
  return import("./resumeRoute");
};

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("the screen a reload comes back to", () => {
  it("a fresh start resumes nothing, and the screen shown is kept for a reload", async () => {
    const { routeBeforeReload, rememberRoute } = await load();
    expect(routeBeforeReload()).toBeNull();
    rememberRoute("store-in-stock");
    // The snapshot is of before this run, not during it.
    expect(routeBeforeReload()).toBeNull();

    const reloaded = await load();
    expect(reloaded.routeBeforeReload()).toBe("store-in-stock");
  });

  it("does not resume a form opened for one record, or something that is not a screen", async () => {
    window.sessionStorage.setItem("erp.resume-route", "party-form");
    expect((await load()).routeBeforeReload()).toBeNull();
    window.sessionStorage.setItem("erp.resume-route", "not-a-screen");
    expect((await load()).routeBeforeReload()).toBeNull();
  });

  it("without storage, behaves as before: nothing resumed, nothing thrown", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { routeBeforeReload, rememberRoute } = await load();
    expect(routeBeforeReload()).toBeNull();
    expect(() => rememberRoute("home")).not.toThrow();
  });
});
