import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { MOVE_IN_PAGES, MOVE_OUT_PAGES, storeJobOfRoute } from "./storeOperators";
import { useStoreJob } from "./useStoreJob";
import type { AppRoute } from "../../app/routes";

describe("which store job a screen belongs to", () => {
  it("knows each job's home and every Move In page", () => {
    expect(storeJobOfRoute("store-in-operator")).toBe("in");
    for (const page of MOVE_IN_PAGES) expect(storeJobOfRoute(page.route)).toBe("in");
    expect(storeJobOfRoute("store-out-operator")).toBe("out");
    for (const page of MOVE_OUT_PAGES) expect(storeJobOfRoute(page.route)).toBe("out");
  });

  it("counts the carton QR Generator as a Move Out page, so the job stays while it is open", () => {
    expect(MOVE_OUT_PAGES.map((page) => page.route)).toContain("qr-generator");
    expect(storeJobOfRoute("qr-generator")).toBe("out");
  });

  it("puts Store Station and every other screen in no job", () => {
    expect(storeJobOfRoute("store-home")).toBeNull();
    expect(storeJobOfRoute("gatepass")).toBeNull();
  });
});

describe("useStoreJob — the job the sidebar shows", () => {
  it("is picked by opening a job, kept through its pages, and cleared by Select Job", () => {
    const { result, rerender } = renderHook(({ route }: { route: AppRoute }) => useStoreJob(route), {
      initialProps: { route: "store-home" as AppRoute },
    });
    expect(result.current).toBeNull();

    rerender({ route: "store-in-operator" });
    expect(result.current).toBe("in");
    rerender({ route: "store-in-stock" });
    expect(result.current).toBe("in");
    // A detour elsewhere keeps the job.
    rerender({ route: "profile" });
    expect(result.current).toBe("in");

    rerender({ route: "store-home" });
    expect(result.current).toBeNull();
    rerender({ route: "store-out-operator" });
    expect(result.current).toBe("out");
  });
});
