import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UNKNOWN_BUILD_INFO, describeBuildInfo, parseBuildInfo, readBuildInfo } from "./buildInfo";

// Provenance must never guess. The one thing worse than not knowing which code is installed is
// believing something false about it — "clean" when the tree was dirty, or a version with no
// commit behind it. So everything unknown stays null, and `dirty: null` is kept distinct from
// `dirty: false`.

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "erp-buildinfo-"));

describe("parseBuildInfo", () => {
  it("reads a well-formed record as written by the build script", () => {
    const info = parseBuildInfo({
      version: "0.2.0",
      commit: "8b43949fa45bc6d1775846a1044ba7cdacfee36d",
      shortCommit: "8b43949fa45b",
      dirty: false,
      builtAt: "2026-10-14T03:00:00.000Z",
      migrationCeiling: 76,
    });
    expect(info).toEqual({
      version: "0.2.0",
      commit: "8b43949fa45bc6d1775846a1044ba7cdacfee36d",
      shortCommit: "8b43949fa45b",
      dirty: false,
      builtAt: "2026-10-14T03:00:00.000Z",
      migrationCeiling: 76,
    });
  });

  it("keeps a dirty build dirty", () => {
    expect(parseBuildInfo({ version: "0.2.0", dirty: true }).dirty).toBe(true);
  });

  it("does not treat an unknown cleanliness as clean", () => {
    expect(parseBuildInfo({ version: "0.2.0" }).dirty).toBeNull();
    expect(parseBuildInfo({ version: "0.2.0", dirty: "false" }).dirty).toBeNull();
    expect(parseBuildInfo({ version: "0.2.0", dirty: 0 }).dirty).toBeNull();
  });

  it("derives the short commit when only the full one was recorded", () => {
    expect(parseBuildInfo({ commit: "8b43949fa45bc6d1775846a1044ba7cdacfee36d" }).shortCommit).toBe("8b43949fa45b");
  });

  it("refuses values of the wrong type rather than coercing them", () => {
    const info = parseBuildInfo({ version: 20, commit: 123, migrationCeiling: "76", builtAt: "" });
    expect(info.version).toBeNull();
    expect(info.commit).toBeNull();
    expect(info.migrationCeiling).toBeNull();
    expect(info.builtAt).toBeNull();
  });

  it("answers UNKNOWN for anything that is not a record", () => {
    for (const raw of [null, undefined, "0.2.0", 42, []]) {
      expect(parseBuildInfo(raw)).toEqual(raw === null || !Array.isArray(raw) ? UNKNOWN_BUILD_INFO : parseBuildInfo(raw));
    }
    expect(parseBuildInfo(null)).toEqual(UNKNOWN_BUILD_INFO);
    expect(parseBuildInfo("0.2.0")).toEqual(UNKNOWN_BUILD_INFO);
  });
});

describe("readBuildInfo", () => {
  it("reads the file the build script writes beside it", () => {
    const dir = tempDir();
    try {
      fs.writeFileSync(
        path.join(dir, "build-info.json"),
        JSON.stringify({ version: "0.2.0", commit: "abcdef0123456789", dirty: false, migrationCeiling: 76 })
      );
      const info = readBuildInfo(dir);
      expect(info.version).toBe("0.2.0");
      expect(info.shortCommit).toBe("abcdef012345");
      expect(info.migrationCeiling).toBe(76);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns UNKNOWN when the file is absent, instead of throwing", () => {
    const dir = tempDir();
    try {
      expect(readBuildInfo(dir)).toEqual(UNKNOWN_BUILD_INFO);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns UNKNOWN when the file is corrupt, instead of throwing", () => {
    const dir = tempDir();
    try {
      fs.writeFileSync(path.join(dir, "build-info.json"), "{ not json");
      expect(readBuildInfo(dir)).toEqual(UNKNOWN_BUILD_INFO);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("describeBuildInfo", () => {
  it("reads back as one line an operator can quote", () => {
    const line = describeBuildInfo({
      version: "0.2.0",
      commit: "8b43949fa45bc6d1775846a1044ba7cdacfee36d",
      shortCommit: "8b43949fa45b",
      dirty: false,
      builtAt: "2026-10-14T03:00:00.000Z",
      migrationCeiling: 76,
    });
    expect(line).toBe("v0.2.0 · 8b43949fa45b · migrations<=76 · built 2026-10-14T03:00:00.000Z");
  });

  it("says plainly when the build was dirty", () => {
    expect(describeBuildInfo({ ...UNKNOWN_BUILD_INFO, version: "0.2.0", shortCommit: "abcdef012345", dirty: true })).toContain(
      "DIRTY BUILD"
    );
  });

  it("says plainly when nothing is known", () => {
    const line = describeBuildInfo(UNKNOWN_BUILD_INFO);
    expect(line).toContain("version unknown");
    expect(line).toContain("revision unknown");
    expect(line).toContain("cleanliness unknown");
  });
});
