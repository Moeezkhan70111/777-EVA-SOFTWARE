// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { authorityRefusal, readMemberAccess } from "./users";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, app: { getVersion: () => "0.0.0" } }));

// What the renderer's Save is taken to mean, at the process boundary.

const asked = (over: Record<string, unknown> = {}) => ({ roleCode: "store", jobRole: "Store", authorityLevel: 20, extraPermissions: [], ...over });

describe("reading a member's Save", () => {
  it("a blank role is no role, not a slip to be left as it was", () => {
    expect(readMemberAccess(asked({ roleCode: "" }))?.roleCode).toBeNull();
    expect(readMemberAccess(asked({ roleCode: null }))?.roleCode).toBeNull();
  });

  it("keeps the authority as it was asked: a quiet clamp would store a number nobody typed", () => {
    expect(readMemberAccess(asked({ authorityLevel: 150 }))?.authorityLevel).toBe(150);
  });

  it("refuses what cannot be read", () => {
    expect(readMemberAccess(asked({ authorityLevel: "20" }))).toBeNull();
    expect(readMemberAccess(asked({ extraPermissions: "logs" }))).toBeNull();
    expect(readMemberAccess(null)).toBeNull();
  });
});

describe("the authority level", () => {
  it("is refused outside 1 to 99, saying so", () => {
    expect(authorityRefusal(0)).toMatch(/between 1 and 99/);
    expect(authorityRefusal(100)).toMatch(/between 1 and 99/);
  });

  it("is accepted at either end", () => {
    expect(authorityRefusal(1)).toBeNull();
    expect(authorityRefusal(99)).toBeNull();
  });
});
