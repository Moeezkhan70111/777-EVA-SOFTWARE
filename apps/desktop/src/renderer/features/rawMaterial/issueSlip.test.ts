import { describe, expect, it } from "vitest";
import { renderIssueSlipHtml } from "./issueSlip";
import { renderReceivingReceiptHtml } from "./receivingReceipt";
import type { RawMaterialIssueSessionSummary, RawMaterialReceivingSessionSummary } from "../../types/desktopApi";

// THE MOVE OUT SLIP (0.3.8) is the Move In receipt's voucher: the same letterhead, session table,
// summary by material and signature line, saying "Issued" and naming the party the packets went to.

const issueSummary = (overrides: Partial<RawMaterialIssueSessionSummary> = {}): RawMaterialIssueSessionSummary => ({
  session: {
    id: "s9",
    code: "RMO-000140",
    sessionNumber: 140,
    deviceId: "d1",
    startedBy: "STORE",
    status: "CLOSED",
    startedAt: "2026-10-29T04:00:00.000Z",
    closedAt: "2026-10-29T04:30:00.000Z",
  },
  partyId: "party-daniyal",
  partyName: "DANIYAL",
  totalPackets: 5,
  byMaterial: [
    { itemDisplayName: "RUBBER UPPER — SK6 — RED — 7/10", packets: 3, quantity: 6, unitCode: "DOZ" },
    { itemDisplayName: "RUBBER UPPER — SK6 — BLACK — 7/10", packets: 2, quantity: 4, unitCode: "DOZ" },
  ],
  bySection: [],
  scans: [],
  ...overrides,
});

const receivingSummary: RawMaterialReceivingSessionSummary = {
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
  totalPackets: 1,
  byMaterial: [{ itemDisplayName: "DANA — EVA — RED", packets: 1, quantity: 25, unitCode: "KG" }],
  scans: [],
};

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

/** The voucher's parts, in order: what makes two slips the same format. */
const layoutOf = (doc: Document): string[] =>
  Array.from(doc.querySelectorAll(".doc > *, .doc-head > *, thead th, .sign > div")).map((node) =>
    node.matches("th, .sign > div") ? (node.textContent ?? "").trim() : node.className
  );

describe("renderIssueSlipHtml", () => {
  it("is laid out exactly as the Move In receipt", () => {
    const slip = parse(renderIssueSlipHtml(issueSummary(), { printedBy: "store-op" }));
    const receipt = parse(renderReceivingReceiptHtml(receivingSummary, { printedBy: "store-op" }));
    expect(layoutOf(slip)).toEqual(layoutOf(receipt));
  });

  it("says Issued and names the party the packets went to", () => {
    const doc = parse(renderIssueSlipHtml(issueSummary()));
    expect(doc.title).toBe("RMO-000140 — DANIYAL");
    expect(doc.querySelector(".doc-head-title")?.textContent).toContain("Raw Material Issued");
    expect(doc.querySelector(".doc-head-title")?.textContent).toContain("DANIYAL");
    expect(doc.querySelector(".session-table td")?.textContent).toBe("RMO-000140");
  });

  it("totals the packets and the quantity by unit", () => {
    const doc = parse(renderIssueSlipHtml(issueSummary()));
    expect(doc.querySelectorAll(".materials-table tbody tr")).toHaveLength(2);
    expect(doc.querySelector(".materials-table tfoot")?.textContent).toContain("5");
    expect(doc.querySelector(".materials-table tfoot")?.textContent).toContain("10 DOZ");
  });

  it("prints who printed it, when given", () => {
    expect(parse(renderIssueSlipHtml(issueSummary(), { printedBy: "store-op" })).querySelector(".printed-by")?.textContent).toBe(
      "Printed by: store-op"
    );
    expect(parse(renderIssueSlipHtml(issueSummary())).querySelector(".printed-by")).toBeNull();
  });

  it("prints a dash, not a blank, for a session with no party yet", () => {
    const doc = parse(renderIssueSlipHtml(issueSummary({ partyId: null, partyName: null })));
    expect(doc.title).toBe("RMO-000140 — —");
  });

  it("says nothing was issued instead of printing an empty table", () => {
    const doc = parse(renderIssueSlipHtml(issueSummary({ totalPackets: 0, byMaterial: [] })));
    expect(doc.querySelector(".materials-table tbody")?.textContent).toBe("Nothing was issued in this session.");
    expect(doc.querySelector(".materials-table tfoot")).toBeNull();
  });

  it("escapes party and material text instead of letting it become markup", () => {
    const html = renderIssueSlipHtml(
      issueSummary({ partyName: "<b>X</b>", byMaterial: [{ itemDisplayName: "<i>Y</i>", packets: 1, quantity: 1, unitCode: "DOZ" }] })
    );
    expect(html).not.toContain("<b>X</b>");
    expect(html).not.toContain("<i>Y</i>");
  });
});
