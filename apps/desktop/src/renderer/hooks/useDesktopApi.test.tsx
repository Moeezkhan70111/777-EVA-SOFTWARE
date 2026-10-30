import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leaseRefusalText } from "../../shared/leaseRefusal";
import { NotificationsProvider } from "../state/NotificationsContext";
import { onLeaseRefusal } from "../state/leaseRefusals";
import { desktopApi } from "./useDesktopApi";
import { NotificationCenter } from "../components/layout/NotificationCenter";

// A refused leased write is announced on EVERY path (docs/37 section W): the gate test on
// 2026-10-25 showed a screen swallowing the main process's sentence and saying "The codes could not
// be registered" instead of who writes the store. The wrapper reports it before any screen sees it.

const ELECTRON_WRAPPED =
  "Error invoking remote method 'erp:generate-raw-material-qr-batch': LeaseError: The raw material store is written on Gate test - holder only. It is read-only here.";

const install = (api: Record<string, unknown>) =>
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });

afterEach(() => vi.useRealTimers());

describe("leaseRefusalText", () => {
  it("reads the sentence out of Electron's wrapping, and nothing out of any other failure", () => {
    expect(leaseRefusalText(new Error(ELECTRON_WRAPPED))).toBe("The raw material store is written on Gate test - holder only. It is read-only here.");
    expect(leaseRefusalText(new Error("Error invoking remote method 'erp:x': Error: PERMISSION_DENIED"))).toBeNull();
    expect(leaseRefusalText("LeaseError: not an Error")).toBeNull();
  });
});

describe("the reporting desktop API", () => {
  it("reports a lease refusal, then hands the caller the very same error", async () => {
    const refused = new Error(ELECTRON_WRAPPED);
    install({ generateRawMaterialQrBatch: vi.fn(async () => Promise.reject(refused)) });
    const heard: string[] = [];
    const stop = onLeaseRefusal((sentence) => heard.push(sentence));
    try {
      await expect(desktopApi().generateRawMaterialQrBatch({} as never)).rejects.toBe(refused);
      expect(heard).toEqual(["The raw material store is written on Gate test - holder only. It is read-only here."]);
    } finally {
      stop();
    }
  });

  it("reports nothing for any other failure, and leaves answers and arguments alone", async () => {
    const listParties = vi.fn(async (query: unknown) => ({ rows: [query] }));
    install({ listParties, getRuntime: vi.fn(async () => Promise.reject(new Error("offline"))) });
    const heard: string[] = [];
    const stop = onLeaseRefusal((sentence) => heard.push(sentence));
    try {
      await expect(desktopApi().listParties({ search: "a" } as never)).resolves.toEqual({ rows: [{ search: "a" }] });
      expect(listParties).toHaveBeenCalledWith({ search: "a" });
      await expect(desktopApi().getRuntime()).rejects.toThrow("offline");
      expect(heard).toEqual([]);
    } finally {
      stop();
    }
  });

  it("keeps its identity, so it is safe in a hook's dependency list, and wraps nested groups too", async () => {
    const refused = new Error(ELECTRON_WRAPPED);
    install({ listParties: vi.fn(), sessionStore: { load: vi.fn(async () => Promise.reject(refused)) } });
    expect(desktopApi()).toBe(desktopApi());
    expect(desktopApi().listParties).toBe(desktopApi().listParties);
    const heard: string[] = [];
    const stop = onLeaseRefusal((sentence) => heard.push(sentence));
    try {
      await expect(desktopApi().sessionStore?.load()).rejects.toBe(refused);
      expect(heard).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

describe("the notice", () => {
  it("a swallowed refusal is still shown, once, naming who writes the store", async () => {
    vi.useFakeTimers();
    install({ generateRawMaterialQrBatch: vi.fn(async () => Promise.reject(new Error(ELECTRON_WRAPPED))) });
    render(<NotificationsProvider><NotificationCenter /></NotificationsProvider>);
    // A screen that throws the error away, twice, as a scanner burst would.
    await act(async () => {
      await desktopApi().generateRawMaterialQrBatch({} as never).catch(() => undefined);
      await desktopApi().generateRawMaterialQrBatch({} as never).catch(() => undefined);
    });
    expect(screen.getAllByText("The raw material store is written on Gate test - holder only. It is read-only here.")).toHaveLength(1);
    expect(screen.getByText("Read-only on this computer")).toBeTruthy();
  });
});
