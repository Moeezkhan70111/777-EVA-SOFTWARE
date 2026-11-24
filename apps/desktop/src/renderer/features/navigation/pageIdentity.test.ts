import { describe, expect, it } from "vitest";
import type { AppRoute } from "../../app/routes";
import { pageIdentityOf } from "./pageIdentity";

// Owner, 15 Nov 2026: "every card page is looking the same". Each Dashboard card's page has its own colour; every
// other page has none and keeps the store blue. (Its card's picture beside the title went on 23 Nov 2026.)

describe("page identity", () => {
  it("gives each Dashboard card page its own colour", () => {
    expect(pageIdentityOf("carton-stock")).toEqual({ tone: "carton" });
    expect(pageIdentityOf("upper-stock")).toEqual({ tone: "upper" });
    expect(pageIdentityOf("dana-stock")).toEqual({ tone: "dana" });
    expect(pageIdentityOf("daily-production")).toEqual({ tone: "daily" });
  });

  it("no two of them share a colour", () => {
    const routes: AppRoute[] = ["carton-stock", "upper-stock", "dana-stock", "daily-production"];
    const tones = routes.map((route) => pageIdentityOf(route)?.tone);
    expect(new Set(tones).size).toBe(4);
  });

  it("leaves every other page as it was", () => {
    expect(pageIdentityOf("stock")).toBeNull();
    expect(pageIdentityOf("machine-program")).toBeNull();
    expect(pageIdentityOf("manual-production")).toBeNull();
  });
});
