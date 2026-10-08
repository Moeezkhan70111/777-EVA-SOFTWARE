import { describe, expect, it } from "vitest";
import { renderReceivingReceiptHtml } from "./receivingReceipt";
import type { RawMaterialReceivingSessionSummary } from "../../types/desktopApi";

const summaryWith = (overrides: Partial<RawMaterialReceivingSessionSummary> = {}): RawMaterialReceivingSessionSummary => ({
  session: {
    id: "s1",
    code: "RMI-000003",
    sessionNumber: 3,
    partyId: "p1",
    partyName: "Vots Chemicals",
    deviceId: "d1",
    startedBy: "storekeeper",
    status: "CLOSED",
    startedAt: "2026-09-30T01:00:00.000Z",
    closedAt: "2026-09-30T01:10:00.000Z",
  },
  totalPackets: 7,
  byMaterial: [
    { itemDisplayName: "DANA — EVA — RED", packets: 1, quantity: 25, unitCode: "KG" },
    { itemDisplayName: "DANA — EVA — BLACK", packets: 2, quantity: 50, unitCode: "KG" },
    { itemDisplayName: "DANA — EVA — BLUE", packets: 3, quantity: 75, unitCode: "KG" },
    { itemDisplayName: "DANA — EVR — RED", packets: 1, quantity: 25, unitCode: "KG" },
  ],
  scans: [],
  ...overrides,
});

describe("renderReceivingReceiptHtml", () => {
  it("prints the session code, the received/closed date and time, and party name", () => {
    const html = renderReceivingReceiptHtml(summaryWith());
    expect(html).toContain("RMI-000003");
    expect(html).toContain("Vots Chemicals");
    // Midnight+1h UTC on 2026-09-30 is still 2026-09-30 in Asia/Karachi (UTC+5).
    expect(html).toContain("30-09-2026");
    expect(html).toContain("6:00 AM - 6:10 AM");
  });

  it("totals packets across all materials and sums quantity by unit", () => {
    const html = renderReceivingReceiptHtml(summaryWith());
    expect(html).toContain(">7<"); // total packets
    expect(html).toContain("175 KG"); // 25 + 50 + 75 + 25, all one unit
  });

  it("keeps a mixed-unit delivery as separate totals instead of adding incompatible units", () => {
    const html = renderReceivingReceiptHtml(
      summaryWith({
        byMaterial: [
          { itemDisplayName: "DANA — EVA — RED", packets: 1, quantity: 25, unitCode: "KG" },
          { itemDisplayName: "BUCKLE — GOLD", packets: 4, quantity: 40, unitCode: "PCS" },
        ],
      })
    );
    expect(html).toContain("25 KG + 40 PCS");
  });

  it("says a session still open has no end yet, rather than guessing one", () => {
    const html = renderReceivingReceiptHtml(
      summaryWith({ session: { ...summaryWith().session, closedAt: null } })
    );
    expect(html).toContain("In progress");
  });

  it("prints who is viewing the voucher when given, and omits the line otherwise", () => {
    const withPrinter = renderReceivingReceiptHtml(summaryWith(), { printedBy: "moeezkhan123" });
    expect(withPrinter).toContain("Printed by: moeezkhan123");

    const withoutPrinter = renderReceivingReceiptHtml(summaryWith());
    expect(withoutPrinter).not.toContain("Printed by");
  });

  it("escapes party and material text instead of letting it become markup", () => {
    const html = renderReceivingReceiptHtml(
      summaryWith({ session: { ...summaryWith().session, partyName: "<img src=x onerror=alert(1)>" } })
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("says nothing was received instead of printing an empty table", () => {
    const html = renderReceivingReceiptHtml(summaryWith({ byMaterial: [], totalPackets: 0 }));
    expect(html).toContain("Nothing was received in this session.");
  });
});
