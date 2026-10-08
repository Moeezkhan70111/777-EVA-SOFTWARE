import { describe, expect, it } from "vitest";
import { isValidRawMaterialQrId } from "@erp/domain";
import { isCompleteQr, sanitizeScanInput } from "./qr";

// What a keyboard-wedge scanner actually types is not always the bare identity: some scanners
// are programmed with a prefix/suffix that frames every scan. This is the one boundary every
// scan station cleans input through, so a scanner quirk is fixed here once, not per station.

describe("sanitizeScanInput", () => {
  it("upper-cases and trims, for hand-typed input", () => {
    expect(sanitizeScanInput("  rm_1_1_8  ")).toBe("RM_1_1_8");
  });

  it("strips control characters a wedge scanner's Enter/Tab suffix can leave behind", () => {
    expect(sanitizeScanInput("RM_1_1_8\r\n")).toBe("RM_1_1_8");
  });

  it("strips a scanner's mis-programmed backslash prefix/suffix, since no real code has one", () => {
    expect(sanitizeScanInput("\\rm_1_1_8\\")).toBe("RM_1_1_8");
    expect(sanitizeScanInput("\\SK6_RED_7/10_000037\\")).toBe("SK6_RED_7/10_000037");
  });

  it("leaves an already-clean identity untouched", () => {
    expect(sanitizeScanInput("RM_1_1_8")).toBe("RM_1_1_8");
  });
});

describe("scanner-framed input still validates as the real identity", () => {
  it("a backslash-wrapped raw material code is recognised once sanitized", () => {
    expect(isValidRawMaterialQrId(sanitizeScanInput("\\rm_1_1_8\\"))).toBe(true);
  });

  it("a backslash-wrapped carton code is still recognised as a complete scan", () => {
    expect(isCompleteQr("\\SK6_RED_7/10_000037\\")).toBe(true);
  });
});
