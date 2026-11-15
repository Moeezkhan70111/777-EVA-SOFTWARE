import { describe, expect, it } from "vitest";
import { CARTON_STOCK_ARTWORK_URL, DAILY_PRODUCTION_ARTWORK_URL, DANA_STOCK_ARTWORK_URL, UPPER_STOCK_ARTWORK_URL } from "../../config/artwork";
import type { AppRoute } from "../../app/routes";
import { pageIdentityOf } from "./pageIdentity";

// Owner, 15 Nov 2026: "every card page is looking the same". Each Dashboard card's page has its own colour and its
// card's picture; every other page has none and keeps the store blue.

describe("page identity", () => {
  it("gives each Dashboard card page its own colour and its card's picture", () => {
    expect(pageIdentityOf("carton-stock")).toEqual({ tone: "carton", artwork: CARTON_STOCK_ARTWORK_URL });
    expect(pageIdentityOf("upper-stock")).toEqual({ tone: "upper", artwork: UPPER_STOCK_ARTWORK_URL });
    expect(pageIdentityOf("dana-stock")).toEqual({ tone: "dana", artwork: DANA_STOCK_ARTWORK_URL });
    expect(pageIdentityOf("daily-production")).toEqual({ tone: "daily", artwork: DAILY_PRODUCTION_ARTWORK_URL });
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
