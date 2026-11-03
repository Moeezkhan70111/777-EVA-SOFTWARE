import { describe, expect, it } from "vitest";
import { deskDoneMessage, deskIdleMessage, describeStoreProgress, isIssuedWhole } from "./gatepassProgress";

// The one wording rule for a gatepass's cartons (docs/42 section 10.2): issued cartons are said to be
// issued, QR cartons to be scanned, and a QR-only gatepass reads exactly as it always has.

const figures = (total: number, issuedDirectly: number, scanned: number, remaining: number) => ({ total, issuedDirectly, scanned, remaining });

describe("describeStoreProgress", () => {
  it("a QR-only gatepass keeps its familiar words", () => {
    expect(describeStoreProgress(figures(5, 0, 2, 3))).toBe("2 of 5 moved out");
    expect(describeStoreProgress(figures(5, 0, 5, 0))).toBe("All moved out");
  });

  it("a manual-only gatepass needs no store scan", () => {
    expect(isIssuedWhole(figures(4, 4, 0, 0))).toBe(true);
    expect(describeStoreProgress(figures(4, 4, 0, 0))).toBe("All cartons issued — No Store Scan Required");
  });

  it("a mixed gatepass says what was issued and how many QR cartons are left -- never that the issued ones were scanned", () => {
    expect(describeStoreProgress(figures(5, 2, 0, 3))).toBe("2 cartons issued directly. Scan the remaining 3 QR cartons.");
    expect(describeStoreProgress(figures(5, 2, 2, 1))).toBe("2 cartons issued directly. Scan the remaining 1 QR carton.");
    expect(describeStoreProgress(figures(5, 2, 3, 0))).toBe("2 cartons issued directly · 3 QR cartons scanned out");
    for (const text of [describeStoreProgress(figures(5, 2, 0, 3)), describeStoreProgress(figures(4, 4, 0, 0))]) {
      expect(text).not.toMatch(/2 (cartons )?scanned|4 (cartons )?scanned|moved out/);
    }
  });
});

describe("the scanning desks' banners", () => {
  it("say there is nothing to scan when every carton was issued, at the store and at the gate", () => {
    expect(deskDoneMessage("STORE", figures(4, 4, 0, 0))).toEqual({ title: "✓ NOTHING TO SCAN", message: "All cartons issued — No Store Scan Required" });
    expect(deskDoneMessage("DISPATCH", figures(4, 4, 0, 0)).message).toBe("All cartons issued — nothing to scan at the gate");
  });

  it("say every QR carton is scanned for a mixed gatepass, and keep the familiar words for a QR-only one", () => {
    expect(deskDoneMessage("STORE", figures(5, 2, 3, 0)).message).toBe("Every QR carton is scanned. Print the slip.");
    expect(deskDoneMessage("STORE", figures(5, 0, 5, 0))).toEqual({ title: "✓ COMPLETE", message: "Every carton is scanned. Print the slip." });
  });

  it("open a mixed gatepass on how many QR cartons to scan, and a QR-only one on the usual prompt", () => {
    expect(deskIdleMessage(figures(5, 2, 0, 3))).toBe("2 cartons issued directly. Scan the remaining 3 QR cartons.");
    expect(deskIdleMessage(figures(5, 0, 0, 5))).toBe("Scan a carton for this Gatepass");
  });
});
