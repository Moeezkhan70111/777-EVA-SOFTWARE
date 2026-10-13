import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import qrcode from "qrcode-generator";
import { QrPreview, renderQrSvgMarkup, renderRawMaterialLabelSheetHtml, cartonLabelLines, renderCartonLabelSheetHtml } from "./qrLabels";
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

// The carton sticker: the QR symbol, then the article, colour and size beside it, each as
// large as the stock allows, with the identity underneath (owner's format, 2026-10-13). The
// QR Generator, QR Management and Program Out all print through it, so a reprint can never
// drift from what the generator produced.
const cartonSheet = (identity: Parameters<typeof cartonLabelLines>[0], ids = [IDENTITY]) =>
  renderCartonLabelSheetHtml({ title: "t", heading: "h", subheading: "s", identity, ids });

/** The font-size each line was drawn at, in inches, top to bottom. */
const lineSizesIn = (html: string): number[] =>
  [...html.matchAll(/class="carton-value[^"]*"[^>]*style="font-size:([\d.]+)in"/g)].map((m) => Number(m[1]));

/**
 * How tall the stack of lines actually prints, in inches — each line's font size times its own
 * line height, which is taller for Urdu (Nastaliq) than for Latin.
 */
const lineStackHeightIn = (html: string): number =>
  [...html.matchAll(/class="(carton-value[^"]*)"[^>]*style="font-size:([\d.]+)in"/g)]
    .reduce((total, m) => total + Number(m[2]) * (m[1].includes("--urdu") ? 1.35 : 1.1), 0);

describe("cartonLabelLines", () => {
  it("says the article, then the colour in Urdu, then the size", () => {
    const lines = cartonLabelLines({ article: "SK12", color: "BLACK", size: "7/10" });

    expect(lines.map((line) => line.value)).toEqual(["SK12", colorValueInUrdu("BLACK"), "7/10"]);
    expect(lines.map((line) => line.urdu)).toEqual([false, true, false]);
    expect(lines[1].value).toMatch(/[\u0600-\u06FF]/);
  });

  // A FIX article is moulded from two soles and has no upper, so its carton names both of them
  // (owner, 2026-10-12). The code still carries one colour, because a QR identity holds one.
  it("names BOTH soles of a fix article, and says which is which", () => {
    const lines = cartonLabelLines({ article: "DC3", color: "BLACK", size: "7/10", innerColor: "ORANGE" });

    expect(lines.map((line) => [line.tag, line.value])).toEqual([
      [undefined, "DC3"],
      ["OUTER", colorValueInUrdu("BLACK")],
      ["INNER", colorValueInUrdu("ORANGE")],
      [undefined, "7/10"],
    ]);
  });

  it("tags nothing when there is only one colour to name", () => {
    const lines = cartonLabelLines({ article: "SK6", color: "BLACK", size: "7/10", innerColor: "   " });
    expect(lines.map((line) => line.tag)).toEqual([undefined, undefined, undefined]);
  });

  // A B carton (EVR FIX, migration 074) is moulded from mixed colours, so it names no colour at
  // all: where the colour would be it says a big B — nothing says "MIX" (owner, 2026-10-13).
  it("prints a big B where the colour would be, and never the word MIX", () => {
    const identity = { article: "EVR9", color: "MIX", size: "7/10", innerColor: "RED", grade: "B" as const };
    const lines = cartonLabelLines(identity);

    expect(lines.map((line) => line.value)).toEqual(["EVR9", "B", "7/10"]);
    expect(lines[1].big).toBe(true);
    expect(lines.some((line) => line.urdu)).toBe(false);

    const html = cartonSheet(identity);
    expect(html).not.toContain(">MIX<");
    expect(html).toContain('aria-label="Grade B"');
    // The identity underneath is the registered code and still carries MIX — a code is not
    // rewritten to suit a label.
    expect(html).toContain(IDENTITY);
  });

  it("prints the B larger than the article and the size beside it", () => {
    const sizes = lineSizesIn(cartonSheet({ article: "EVR9", color: "MIX", size: "7/10", grade: "B" }));
    const [article, grade, size] = sizes;

    expect(grade).toBeGreaterThan(article);
    expect(grade).toBeGreaterThan(size);
    // Still inside the sticker: the three lines' own heights fit the artwork.
    expect(lineStackHeightIn(cartonSheet({ article: "EVR9", color: "MIX", size: "7/10", grade: "B" }))).toBeLessThanOrEqual(1.84);
  });

  it("drops a missing colour or size instead of printing a blank line", () => {
    expect(cartonLabelLines({ article: "SK6", color: "", size: "" }).map((line) => line.value)).toEqual(["SK6"]);
  });
});

describe("renderCartonLabelSheetHtml", () => {
  it("prints one sticker per identity: the symbol, the three lines, and the code underneath", () => {
    const html = cartonSheet({ article: "SK12", color: "BLACK", size: "7/10" });

    expect(html.match(/class="carton-label"/g)).toHaveLength(1);
    expect(html).toContain('<div class="carton-qr">');
    expect(html).toContain("SK12");
    expect(html).toContain(IDENTITY);
    // The symbol comes first, then the lines, then the code — reading order as well as layout.
    expect(html.indexOf('class="carton-qr"')).toBeLessThan(html.indexOf('class="carton-lines"'));
    expect(html.indexOf('class="carton-lines"')).toBeLessThan(html.indexOf('class="carton-code"'));
  });

  it("prints a sticker per code, all at the same size, for a whole run", () => {
    const html = cartonSheet({ article: "SK12", color: "BLACK", size: "7/10" }, [
      "SK12_BLACK_7/10_000001",
      "SK12_BLACK_7/10_000002",
    ]);
    expect(html.match(/class="carton-label"/g)).toHaveLength(2);
    expect(new Set(html.match(/class="carton-code" style="font-size:[\d.]+in"/g)).size).toBe(1);
  });

  it("prints the lines far larger than the code, and inside the sticker", () => {
    const html = cartonSheet({ article: "SK12", color: "BLACK", size: "7/10" });
    const sizes = lineSizesIn(html);
    const codeSizeIn = Number(html.match(/class="carton-code" style="font-size:([\d.]+)in"/)?.[1]);

    expect(sizes).toHaveLength(3);
    // Three lines sharing the 1.84in of artwork above a ~0.12in code line: well over a third
    // of an inch each, and never so tall that the three of them overrun the sticker.
    sizes.forEach((sizeIn) => expect(sizeIn).toBeGreaterThan(0.35));
    expect(lineStackHeightIn(html)).toBeLessThanOrEqual(1.84);
    expect(Math.min(...sizes)).toBeGreaterThan(codeSizeIn * 2);
  });

  it("shrinks the lines rather than overrunning the sticker when a fix carton needs four", () => {
    const three = cartonSheet({ article: "SK12", color: "BLACK", size: "7/10" });
    const four = cartonSheet({ article: "DC3", color: "BLACK", size: "7/10", innerColor: "ORANGE" });

    expect(lineSizesIn(four)).toHaveLength(4);
    expect(Math.max(...lineSizesIn(four))).toBeLessThan(Math.max(...lineSizesIn(three)));
    expect(lineStackHeightIn(four)).toBeLessThanOrEqual(1.84);
  });

  it("draws the colour in the Urdu typeface and the article and size in the Latin one", () => {
    const html = cartonSheet({ article: "SK12", color: "BLACK", size: "7/10" });
    expect(html.match(/class="carton-value carton-value--urdu"/g)).toHaveLength(1);
    expect(html.match(/class="carton-value"/g)).toHaveLength(2);
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
