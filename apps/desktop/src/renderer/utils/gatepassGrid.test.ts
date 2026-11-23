import { describe, expect, it } from "vitest";
import { buildDocumentGrid } from "./gatepassGrid";
import { renderGatepassPrintHtml } from "./gatepassPrint";
import type { Gatepass } from "../types/desktopApi";

// The created gatepass's grid, as Gatepass List and the printout draw it. One colour is one column however each
// article happens to spell it (owner, 23 Nov 2026: gatepass 200000 printed BLACK GREY twice).

const line = (article: string, color: string, size: string, quantity: number) => ({ article, color, size, quantity, groupName: null });

describe("gatepass document grid", () => {
  it("puts one colour spelled differently on different articles in one column", () => {
    const grid = buildDocumentGrid([
      line("SK6", "BLACK GREY", "7/10", 3),
      line("SK9", "BLACKGREY", "7/10", 1),
      line("SK12", "Black Grey ", "4/6", 2),
      line("SK12", "BLACK-GREY", "7/10", 1),
      line("SK6", "NAVY", "7/10", 4),
    ]);
    expect(grid.colours).toEqual(["BLACK GREY", "NAVY"]);
    expect(grid.columnTotals).toEqual({ "BLACK GREY": 7, NAVY: 4 });
    expect(grid.rows.find((row) => row.article === "SK9")?.quantities).toEqual({ "BLACK GREY": 1 });
    expect(grid.total).toBe(11);
  });

  it("heads the column with the spelling most of its cartons carry", () => {
    const grid = buildDocumentGrid([line("SK6", "BLACKGREY", "7/10", 5), line("SK9", "BLACK GREY", "7/10", 1)]);
    expect(grid.colours).toEqual(["BLACKGREY"]);
  });

  it("keeps different colours apart", () => {
    const grid = buildDocumentGrid([line("SK6", "BLACK", "7/10", 1), line("SK6", "GREY", "7/10", 1), line("SK6", "BLACK GREY", "4/6", 1)]);
    expect(grid.colours).toEqual(["BLACK", "BLACK GREY", "GREY"]);
  });

  it("prints a single BLACK GREY column for the two spellings", () => {
    const gatepass = {
      id: "gp-1", gatepassNumber: 200000, code: "GP-200000", businessDate: "2026-11-23", partyId: "p1", partyName: "ABC TRADERS", partyCode: "P-0001", partyCity: "Lahore",
      status: "ACTIVE", lines: [{ ...line("SK6", "BLACK GREY", "7/10", 3), id: "l1" }, { ...line("SK9", "BLACKGREY", "7/10", 1), id: "l2" }],
    } as unknown as Gatepass;
    const html = renderGatepassPrintHtml(gatepass);
    expect(html.match(/<th scope="col">BLACK GREY<\/th>/g)).toHaveLength(1);
    expect(html).not.toContain(">BLACKGREY<");
  });
});
