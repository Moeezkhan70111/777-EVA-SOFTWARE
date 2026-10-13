import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import qrcode from "qrcode-generator";
import { QrPreview, renderQrSvgMarkup, renderRawMaterialLabelSheetHtml, cartonLabelHeader } from "./qrLabels";
import { colorValueInUrdu } from "./urdu";

// The carton label carries a QR code, and the only thing it encodes is the registered identity.
// These tests pin the geometry the printer and the screen are given: a wrong symbol would be
// discovered on the factory floor, one scan at a time.

const IDENTITY = "SK6_RED_7/10_000037";
/** Blank modules kept on all four sides of the symbol — must match QUIET_ZONE_MODULES. */
const QUIET_ZONE = 4;

/** The symbol the encoder produces for an identity, independent of how we draw it. */
const encode = (value: string) => {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr;
};

const pathOf = (markup: string): string => markup.match(/ d="([^"]*)"/)?.[1] ?? "";

describe("renderQrSvgMarkup", () => {
  it("draws every dark module of the encoded identity, and nothing else", () => {
    const qr = encode(IDENTITY);
    const moduleCount = qr.getModuleCount();

    let darkModules = 0;
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount; col += 1) {
        if (qr.isDark(row, col)) darkModules += 1;
      }
    }

    const segments = pathOf(renderQrSvgMarkup(IDENTITY)).match(/M\d+ \d+h1v1h-1z/g) ?? [];
    expect(segments).toHaveLength(darkModules);
  });

  it("keeps the quiet zone the QR specification requires on all four sides", () => {
    const side = encode(IDENTITY).getModuleCount() + 2 * QUIET_ZONE;
    const markup = renderQrSvgMarkup(IDENTITY);

    expect(markup).toContain(`viewBox="0 0 ${side} ${side}"`);

    // The top-left finder pattern starts at module (0,0), so with the quiet zone applied the
    // first drawn square sits at QUIET_ZONE, and nothing is drawn outside the box.
    const coordinates = [...pathOf(markup).matchAll(/M(\d+) (\d+)h/g)].map(([, x, y]) => [Number(x), Number(y)]);
    expect(coordinates).toContainEqual([QUIET_ZONE, QUIET_ZONE]);
    expect(Math.min(...coordinates.map(([x]) => x))).toBe(QUIET_ZONE);
    expect(Math.max(...coordinates.map(([x]) => x))).toBeLessThan(side - QUIET_ZONE);
    expect(Math.max(...coordinates.map(([, y]) => y))).toBeLessThan(side - QUIET_ZONE);
  });

  it("gives two identities two different symbols", () => {
    expect(pathOf(renderQrSvgMarkup(IDENTITY))).not.toEqual(pathOf(renderQrSvgMarkup("SK6_RED_7/10_000038")));
  });

  it("falls back to the plain identity rather than losing a value it cannot encode", () => {
    // Past the capacity of the largest QR version, so the encoder refuses it.
    const tooLong = "X".repeat(5000);
    expect(renderQrSvgMarkup(tooLong)).toContain("label-fallback");
  });
});

// A carton prints the SAME sticker as a raw material packet: one template, so a reprint from
// QR Management can never drift from what the QR Generator produced.
describe("cartonLabelHeader", () => {
  it("says the article large, the size beside the symbol, and the colour in Urdu", () => {
    const header = cartonLabelHeader({ article: "SK6", color: "BLACK", size: "7/10" });

    expect(header.categoryLine).toBe("SK6");
    expect(header.subCategoryLine).toBe("");
    expect(header.attributes.map((a) => a.value)).toEqual(["7/10", colorValueInUrdu("BLACK")]);
    expect(header.attributes.find((a) => a.isColor)?.value).toMatch(/[\u0600-\u06FF]/);
  });

  // A FIX article is moulded from two soles and has no upper, so its carton names both of them
  // (owner, 2026-10-12). The code still carries one colour, because a QR identity holds one.
  it("names BOTH soles of a fix article, and says which is which", () => {
    const header = cartonLabelHeader({ article: "DC3", color: "BLACK", size: "7/10", innerColor: "ORANGE" });

    expect(header.categoryLine).toBe("DC3");
    expect(header.attributes.map((a) => a.label)).toEqual(["SIZE", "OUTER SOLE", "INNER SOLE"]);
    expect(header.attributes.map((a) => a.value)).toEqual([
      "7/10",
      colorValueInUrdu("BLACK"),
      colorValueInUrdu("ORANGE"),
    ]);
    // Both are colours, so both print large in Urdu the way the floor reads them.
    expect(header.attributes.filter((a) => a.isColor)).toHaveLength(2);
  });

  it("says COLOUR, not OUTER SOLE, for a carton with one colour", () => {
    const header = cartonLabelHeader({ article: "SK6", color: "BLACK", size: "7/10", innerColor: "   " });
    expect(header.attributes.map((a) => a.label)).toEqual(["SIZE", "COLOUR"]);
  });

  // A B carton (EVR FIX, mixed colours, migration 074): a B in the top-left corner, COLOUR MIX.
  it("prints a B carton with a B in the corner and COLOUR MIX", () => {
    const header = cartonLabelHeader({ article: "EVR9", color: "MIX", size: "7/10", innerColor: "RED", grade: "B" });
    expect(header.gradeMark).toBe("B");
    expect(header.categoryLine).toBe("EVR9");
    expect(header.attributes.map((a) => [a.label, a.value])).toEqual([["SIZE", "7/10"], ["COLOUR", "MIX"]]);

    const html = renderRawMaterialLabelSheetHtml({ title: "t", heading: "h", subheading: "s", header, ids: ["EVR9_MIX_7/10_000001"] });
    expect(html).toContain('class="rm-label-grade" aria-label="Grade B">B</div>');
    expect(html).toContain("rm-label-heading--graded");
  });

  it("leaves out what a carton does not have, rather than printing an empty supplier line", () => {
    const header = cartonLabelHeader({ article: "SK6", color: "BLACK", size: "7/10" });
    expect(header.partyName).toBe("");
    expect(header.packQuantity).toBe("");
  });

  it("drops a missing colour or size instead of printing a blank line", () => {
    const header = cartonLabelHeader({ article: "SK6", color: "", size: "" });
    expect(header.attributes).toEqual([]);
  });

  it("prints the carton through the one shared sticker template", () => {
    const sheet = renderRawMaterialLabelSheetHtml({
      title: "t",
      heading: "h",
      subheading: "s",
      header: cartonLabelHeader({ article: "SK6", color: "BLACK", size: "7/10" }),
      ids: [IDENTITY],
    });
    expect(sheet.match(/class="rm-label"/g)).toHaveLength(1);
    expect(sheet).toContain("SK6");
    expect(sheet).toContain(IDENTITY);
  });
});
describe("renderRawMaterialLabelSheetHtml", () => {
  const RM_ID = "RM_6_42_1";
  // Attribute values arrive already formatted for print (e.g. Colour already translated to
  // Urdu by materialLabelAttributes) — this template only decides how they are laid out.
  const header = {
    categoryLine: "UPPER",
    subCategoryLine: "RUBBER",
    attributes: [
      { label: "Colour", value: "کالا", isColor: true },
      { label: "Thickness", value: "3 MM", isColor: false },
    ],
    partyName: "Acme Rubber Co.",
    packQuantity: "",
  };

  const sheet = renderRawMaterialLabelSheetHtml({
    title: "Raw Material QR",
    heading: "Acme Rubber Co. — RUBBER UPPER",
    subheading: "2 codes",
    header,
    ids: [RM_ID, "RM_6_42_2"],
  });

  /** Pulls the inline `font-size:…in` a rendered element carries, by the text it wraps. */
  const fontSizeOf = (html: string, text: string): number => {
    const match = html.match(new RegExp(`style="font-size:([\\d.]+)in"[^>]*>${text}<`));
    return match ? Number(match[1]) : NaN;
  };

  it("prints one sticker per id, each carrying the shared category, attributes and party name", () => {
    expect(sheet.match(/class="rm-label"/g)).toHaveLength(2);
    expect(sheet).toContain(RM_ID);
    expect(sheet).toContain("UPPER");
    expect(sheet).toContain("RUBBER");
    // Just the value — no "Colour: " label prefix on the printed attribute list.
    expect(sheet).toContain(">کالا<");
    expect(sheet).toContain(">3 MM<");
    expect(sheet).not.toContain("Colour:");
    expect(sheet.match(/Acme Rubber Co\./g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("prints the packet quantity as a bare bold figure in the bottom-left corner, only when there is one", () => {
    expect(sheet).not.toContain('class="rm-label-pack-qty"');

    const withQty = renderRawMaterialLabelSheetHtml({
      title: "Raw Material QR",
      heading: "h",
      subheading: "s",
      header: { ...header, packQuantity: "5" },
      ids: [RM_ID],
    });
    const corner = withQty.match(/<div class="rm-label-pack-qty"[^>]*>(.*?)<\/div>/)?.[1];
    expect(corner).toBe("5");
    // Left of the party/code block, inside the footer row.
    expect(withQty.indexOf('class="rm-label-pack-qty"')).toBeLessThan(withQty.indexOf('class="rm-label-party"'));
    expect(withQty.indexOf('class="rm-label-footer-row"')).toBeLessThan(withQty.indexOf('class="rm-label-pack-qty"'));
  });

  it("prints the unique code in its own footer, separate from the QR symbol", () => {
    const qrBlock = sheet.match(/<div class="rm-label-qr">.*?<\/div>/s)?.[0] ?? "";
    expect(qrBlock).not.toContain(RM_ID);

    // The footer holds both the party name and the code, party name first.
    const partyIndex = sheet.indexOf("rm-label-party");
    const codeIndex = sheet.indexOf("rm-label-code");
    expect(partyIndex).toBeGreaterThan(-1);
    expect(codeIndex).toBeGreaterThan(partyIndex);
  });

  it("gives the colour its own dedicated, much larger element in a proper Urdu font — not a line in the attribute list", () => {
    expect(sheet).toContain('<div class="rm-label-color">');
    // Not sharing a column with the plain attributes — colour has one of its own beside them.
    const plainAttrsBlock = sheet.match(/<div class="rm-label-plain-attrs"[^>]*>.*?<\/div>/s)?.[0] ?? "";
    expect(plainAttrsBlock).not.toContain("کالا");

    const colorSize = fontSizeOf(sheet, "کالا");
    const plainSize = fontSizeOf(sheet, "3 MM");
    expect(colorSize).toBeGreaterThan(plainSize * 2); // dominant, not just a modest bump

    expect(sheet).toContain("Noto Nastaliq Urdu");
  });

  it("shrinks a long category name and grows a short one, instead of one fixed size for both", () => {
    const short = renderRawMaterialLabelSheetHtml({
      title: "t", heading: "h", subheading: "s",
      header: { ...header, categoryLine: "EVA" },
      ids: ["RM_1_1_1"],
    });
    const long = renderRawMaterialLabelSheetHtml({
      title: "t", heading: "h", subheading: "s",
      header: { ...header, categoryLine: "SYNTHETIC RUBBER COMPOUND" },
      ids: ["RM_1_1_1"],
    });
    const shortSize = fontSizeOf(short, "EVA");
    const longSize = fontSizeOf(long, "SYNTHETIC RUBBER COMPOUND");
    expect(shortSize).toBeGreaterThan(longSize);
  });

  it("escapes header text instead of letting it become markup", () => {
    const hostile = renderRawMaterialLabelSheetHtml({
      title: "t",
      heading: "h",
      subheading: "s",
      header: { ...header, partyName: "<img src=x onerror=alert(1)>" },
      ids: ["RM_1_1_1"],
    });
    expect(hostile).not.toContain("<img src=x");
    expect(hostile).toContain("&lt;img src=x");
  });

  it("prints only the category line for a material with no sub-category", () => {
    const single = renderRawMaterialLabelSheetHtml({
      title: "t",
      heading: "h",
      subheading: "s",
      header: { ...header, subCategoryLine: "" },
      ids: ["RM_1_1_1"],
    });
    expect(single).not.toContain('class="rm-subcategory"');
  });

  it("gives the plain attributes the full width instead of a narrow column when there is no colour to make room for", () => {
    const noColor = renderRawMaterialLabelSheetHtml({
      title: "t", heading: "h", subheading: "s",
      header: { ...header, attributes: [{ label: "Name", value: "SK12", isColor: false }] },
      ids: ["RM_1_1_1"],
    });
    expect(noColor).not.toContain('class="rm-label-color"');
    expect(noColor).toContain('class="rm-label-plain-attrs" style="flex:1"');
  });
});

describe("QrPreview", () => {
  it("shows the symbol with an accessible name and the identity beneath it", () => {
    render(<QrPreview value={IDENTITY} />);
    expect(screen.getByRole("img", { name: `QR code for ${IDENTITY}` })).toBeInTheDocument();
    expect(screen.getByText(IDENTITY)).toBeInTheDocument();
  });

  it("still shows the identity when the symbol cannot be drawn", () => {
    const tooLong = "X".repeat(5000);
    render(<QrPreview value={tooLong} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(tooLong)).toBeInTheDocument();
  });
});
