import { describe, expect, it } from "vitest";
import { ImportFileError, parseDelimitedText } from "./importFile";
import { toCsv } from "./exportFile";

// The parser reads a file somebody made in Excel, so it has to survive whatever they saved.
// The case that matters most is the round trip: a materials export edited and sent back must
// come out with the same cells it went in with.

describe("parseDelimitedText", () => {
  it("reads headings and rows", () => {
    const sheet = parseDelimitedText("ARTICLE,COLOR\nSK6,RED\nSK9,BLACK\n");
    expect(sheet.headers).toEqual(["ARTICLE", "COLOR"]);
    expect(sheet.rows).toEqual([
      { ARTICLE: "SK6", COLOR: "RED" },
      { ARTICLE: "SK9", COLOR: "BLACK" },
    ]);
  });

  it("keeps a comma inside a quoted cell", () => {
    const sheet = parseDelimitedText('ARTICLE,REMARKS\nSK6,"damaged, returned"\n');
    expect(sheet.rows[0].REMARKS).toBe("damaged, returned");
  });

  it("keeps a newline inside a quoted cell as one row", () => {
    const sheet = parseDelimitedText('ARTICLE,REMARKS\nSK6,"line one\nline two"\nSK9,fine\n');
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0].REMARKS).toBe("line one\nline two");
  });

  it('unescapes a doubled quote', () => {
    const sheet = parseDelimitedText('ARTICLE,NOTE\nSK6,"he said ""no"""\n');
    expect(sheet.rows[0].NOTE).toBe('he said "no"');
  });

  it("skips the byte-order mark Excel writes", () => {
    const sheet = parseDelimitedText("﻿ARTICLE,COLOR\nSK6,RED\n");
    expect(sheet.headers).toEqual(["ARTICLE", "COLOR"]);
  });

  it("accepts a tab-separated file, which is Excel's other save option", () => {
    const sheet = parseDelimitedText("ARTICLE\tCOLOR\nSK6\tRED\n");
    expect(sheet.rows[0]).toEqual({ ARTICLE: "SK6", COLOR: "RED" });
  });

  it("drops blank lines rather than importing empty materials", () => {
    const sheet = parseDelimitedText("ARTICLE,COLOR\nSK6,RED\n\n,,\nSK9,BLACK\n");
    expect(sheet.rows).toHaveLength(2);
  });

  it("finds the headings under our own export's title and filter lines", () => {
    const csv = toCsv({
      preamble: ["777 ERP — Raw Materials & Stock", "Taken 28 Sept 2026", "Category: RUBBER UPPER"],
      headers: ["Category", "ARTICLE", "COLOR"],
      rows: [["RUBBER UPPER", "SK6", "RED"]],
    });

    const sheet = parseDelimitedText(csv);
    expect(sheet.headers).toEqual(["Category", "ARTICLE", "COLOR"]);
    expect(sheet.rows).toEqual([{ Category: "RUBBER UPPER", ARTICLE: "SK6", COLOR: "RED" }]);
  });

  it("keeps a size like 7/10 as text, not a date", () => {
    const csv = toCsv({ headers: ["SIZE"], rows: [["7/10"]] });
    expect(parseDelimitedText(csv).rows[0].SIZE).toBe("7/10");
  });

  it("refuses a file with nothing in it", () => {
    expect(() => parseDelimitedText("   \n\n")).toThrow(ImportFileError);
  });

  it("refuses a file with headings but no rows", () => {
    expect(() => parseDelimitedText("ARTICLE,COLOR\n")).toThrow(/no rows/i);
  });
});
