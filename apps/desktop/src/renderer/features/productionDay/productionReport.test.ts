import { describe, expect, it } from "vitest";
import { buildProductionDay } from "@erp/domain";
import { copy } from "../../config/copy";
import { productionReportFileName, productionReportHtml } from "./productionReport";
import { parseSavePdfReply } from "./useProductionPdf";

// The Daily Production PDF: logo, the day, whether it is complete, the totals, then each machine's articles as Size x
// Colour tables in dozens. Minimal: no rates, no money, no entry codes.

const text = copy.productionReport;

// The owner's example (14 Nov 2026): SK12, 7/10 BLACKBLUE 1, BLACKRED 2, GREEN 54; 4/6 BLACKBLUE 2, BLACKRED 10.
const line = (machineName: string, article: string, size: string, color: string, dozens: number) => ({ machineName, article, size, color, cartons: dozens * 2, entries: 1 });
const DAY = buildProductionDay(
  "2026-11-14",
  [
    line("MACHINE 1", "SK12", "7/10", "BLACKBLUE", 1),
    line("MACHINE 1", "SK12", "7/10", "BLACKRED", 2),
    line("MACHINE 1", "SK12", "7/10", "GREEN", 54),
    line("MACHINE 1", "SK12", "4/6", "BLACKBLUE", 2),
    line("MACHINE 1", "SK12", "4/6", "BLACKRED", 10),
    line("MACHINE 2", "SK6", "7/10", "RED", 5),
  ],
  { date: "2026-11-14", completedAt: "2026-11-14T13:40:00.000Z", completedBy: "admin", cartons: 148, entries: 6 }
);

const page = (machineName: string | null, logoDataUrl = "") => productionReportHtml({ day: DAY, machineName, logoDataUrl, printedAt: new Date("2026-11-14T13:45:00.000Z") });
const asDocument = (html: string) => new DOMParser().parseFromString(html, "text/html");
const all = (root: ParentNode, selector: string): Element[] => Array.from(root.querySelectorAll(selector));
const texts = (root: ParentNode, selector: string) => all(root, selector).map((element) => element.textContent);
const tableRows = (table: Element) => all(table, "tr").map((row) => all(row, "th, td").map((cell) => cell.textContent?.trim()));

describe("the whole day", () => {
  const doc = asDocument(page(null));

  it("has the title, the day and whether it is complete", () => {
    expect(doc.querySelector("h1")?.textContent).toBe(text.title);
    expect(doc.querySelector(".day")?.textContent).toMatch(/14/);
    expect(doc.body.textContent).toContain("✓ Completed at");
    expect(doc.body.textContent).toContain("by admin");
    expect(doc.body.textContent).toContain(text.allMachines);
  });

  it("gives the totals: 74 dozen, 148 cartons, 2 machines, 6 entries", () => {
    expect(texts(doc, ".figure strong")).toEqual(["74", "148", "2", "6"]);
  });

  it("draws the owner's SK12 as sizes down and colours across, in dozens, with every total", () => {
    const [sk12] = all(doc, "table");
    expect(tableRows(sk12)).toEqual([
      ["SK12", "BLACKBLUE", "BLACKRED", "GREEN", "Total"],
      ["7/10", "1", "2", "54", "57"],
      ["4/6", "2", "10", "-", "12"],
      ["Total", "3", "12", "54", "69"],
    ]);
  });

  it("has a section per machine, then all machines together", () => {
    expect(texts(doc, "h2")).toEqual([
      text.machineHeading("MACHINE 1", "69"),
      text.machineHeading("MACHINE 2", "5"),
      text.allMachinesHeading("74"),
    ]);
  });

  it("prints the logo when there is one, and the brand in words when not", () => {
    expect(asDocument(page(null, "data:image/png;base64,AAAA")).querySelector(".letterhead img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(doc.querySelector(".brand-text")?.textContent).toContain(text.brand);
  });
});

describe("one machine", () => {
  const doc = asDocument(page("MACHINE 2"));

  it("has only that machine, its own totals, and no all-machines section", () => {
    expect(texts(doc, "h2")).toEqual([text.machineHeading("MACHINE 2", "5")]);
    expect(texts(doc, ".figure strong")).toEqual(["5", "10", "1", "1"]);
    expect(doc.body.textContent).not.toContain("SK12");
  });

  it("says so plainly when that machine has nothing", () => {
    expect(asDocument(page("MACHINE 9")).querySelector(".empty")?.textContent).toBe(text.empty);
  });

  it("is named for the day and the machine", () => {
    expect(productionReportFileName("2026-11-14", null)).toBe("Daily Production 2026-11-14.pdf");
    expect(productionReportFileName("2026-11-14", "MACHINE 2")).toBe("Daily Production 2026-11-14 MACHINE 2.pdf");
  });
});

describe("safety", () => {
  it("escapes every text that came from the data", () => {
    const hostile = buildProductionDay("2026-11-14", [line("<b>M</b>", "<script>alert(1)</script>", "7/10", "RED\"", 1)], null);
    const html = productionReportHtml({ day: hostile, machineName: null, logoDataUrl: "", printedAt: new Date() });
    // The day's names come upper-cased from the domain; escaped either way.
    const upper = html.toUpperCase();
    expect(upper).not.toContain("<SCRIPT>ALERT(1)</SCRIPT>");
    expect(upper).not.toContain("<B>M</B>");
    expect(upper).toContain("&LT;SCRIPT&GT;");
    expect(asDocument(html).body.textContent).toContain(text.notCompleted);
  });
});

describe("the main process's answer to Save PDF, checked", () => {
  it.each([
    [{ accepted: true, filePath: "C:\\Reports\\Daily Production 2026-11-14.pdf" }, { kind: "saved", filePath: "C:\\Reports\\Daily Production 2026-11-14.pdf" }],
    [{ accepted: false, canceled: true }, { kind: "canceled" }],
    [{ accepted: false, reason: "The disk is full." }, { kind: "failed", reason: "The disk is full." }],
    [{ accepted: true }, { kind: "failed", reason: null }],
    [null, { kind: "failed", reason: null }],
  ])("%j", (reply, expected) => {
    expect(parseSavePdfReply(reply)).toEqual(expected);
  });
});
