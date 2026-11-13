// electron-updater's log, as it reaches app.log: nothing secret, nothing routine, nothing twice.

import { describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@erp/data";
import { createUpdaterLogger, sanitizeUpdaterLine } from "./updaterLog";

const TOKEN = "ghp_THISISTHETOKEN1234567890";

const make = (now: () => number = () => 0) => {
  const log = vi.fn();
  const logger = createUpdaterLogger({ logger: { log } as unknown as StructuredLogger, deviceId: "device-1", secrets: [TOKEN], now });
  const messages = () => log.mock.calls.map(([entry]) => (entry as { message: string }).message);
  return { log, logger, messages };
};

describe("what is taken out of a line", () => {
  it.each([
    ["the configured token", `Bad credentials for ${TOKEN}`, "Bad credentials for [redacted]"],
    ["anything shaped like a GitHub token", "sent github_pat_11ABCDEFG0123456789_abcdef by mistake", "sent [redacted] by mistake"],
    ["an Authorization header", `headers: {"authorization":"token abc123secret"}`, `headers: {"authorization":"[redacted]"}`],
    [
      "a URL's query string",
      "Redirect to https://objects.githubusercontent.com/a/b?X-Amz-Signature=s&X-Amz-Credential=c done",
      "Redirect to https://objects.githubusercontent.com/a/b done",
    ],
  ])("removes %s", (_what, raw, expected) => {
    expect(sanitizeUpdaterLine(raw, [TOKEN])).toBe(expected);
  });

  it("cuts a very long line (a stack trace) to a readable length", () => {
    expect(sanitizeUpdaterLine("x".repeat(5000)).length).toBeLessThanOrEqual(1501);
  });
});

describe("what is written", () => {
  it("drops the two lines every quiet check would otherwise add", () => {
    const { logger, messages } = make();
    logger.info("Checking for update");
    logger.info("Update for version 0.5.9 is not available (latest version: 0.5.9, downgrade is disallowed).");
    expect(messages()).toEqual([]);
  });

  it("keeps what explains an update: delta or full, found, downloaded, failed", () => {
    const { logger, log } = make();
    logger.info("Full: 108.3 MB, To download: 6.2 MB (6%)");
    logger.error("Cannot download differentially, fallback to full download: Error: blockmap 404");
    expect(log.mock.calls.map(([entry]) => (entry as { severity: string }).severity)).toEqual(["INFO", "ERROR"]);
  });

  it("writes the same line once an hour at most, so an offline day does not fill the disk", () => {
    let now = 0;
    const { logger, messages } = make(() => now);
    logger.warn("Error: net::ERR_INTERNET_DISCONNECTED");
    now += 10 * 60 * 1000;
    logger.warn("Error: net::ERR_INTERNET_DISCONNECTED");
    expect(messages()).toHaveLength(1);
    now += 61 * 60 * 1000;
    logger.warn("Error: net::ERR_INTERNET_DISCONNECTED");
    expect(messages()).toHaveLength(2);
  });

  it("ignores debug lines and never throws when the log cannot be written", () => {
    const failing = { log: () => { throw new Error("disk full"); } } as unknown as StructuredLogger;
    const logger = createUpdaterLogger({ logger: failing, deviceId: "d" });
    logger.debug("range request 1-2");
    expect(() => logger.info("Found version 1.0.0")).not.toThrow();
  });
});
