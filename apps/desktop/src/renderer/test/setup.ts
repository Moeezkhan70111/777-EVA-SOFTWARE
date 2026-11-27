import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no ResizeObserver; Electron (Chromium) does. Components that measure
// themselves with one get a stand-in that never reports a size. Only where the environment lacks it.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStandIn {
    observe(): void { /* nothing to measure in jsdom */ }
    unobserve(): void { /* nothing to measure in jsdom */ }
    disconnect(): void { /* nothing to measure in jsdom */ }
  }
  globalThis.ResizeObserver = ResizeObserverStandIn as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
});
