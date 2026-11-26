import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotificationsProvider, useNotifications } from "../../state/NotificationsContext";
import { NotificationCenter } from "./NotificationCenter";

// The notice island (dynaura, 26 Nov 2026): the newest open notice is the one shown; one that waits for an answer never
// holds back the ones after it, and comes back once they are gone.

let api: ReturnType<typeof useNotifications> | null = null;
const Grab: React.FC = () => { api = useNotifications(); return null; };

const show = () => render(<NotificationsProvider><Grab /><NotificationCenter /></NotificationsProvider>);

describe("NotificationCenter as a Dynamic Island", () => {
  it("shows the newest notice, and the one waiting behind it returns when it goes", async () => {
    show();
    act(() => api?.push("warning", "Carton Cloud could not be read", undefined, 0));
    expect(await screen.findByText("Carton Cloud could not be read")).toBeInTheDocument();
    act(() => api?.push("error", "Gatepass not found", "It may have been removed."));
    expect(await screen.findByText("Gatepass not found")).toBeInTheDocument();
    const newest = api?.notices[0]?.id ?? "";
    act(() => api?.dismiss(newest));
    expect(await screen.findByText("Carton Cloud could not be read")).toBeInTheDocument();
  });

  it("a notice closed by hand (Escape here; a tap or swipe the same) is gone from the list too", async () => {
    show();
    act(() => api?.push("info", "Saved", undefined, 0));
    await screen.findByText("Saved");
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    await waitFor(() => expect(api?.notices).toHaveLength(0));
  });

  // Every island closes by itself after four seconds (owner, 26 Nov 2026), even one pushed to stay.
  it("closes by itself after four seconds, and the notice leaves the list", async () => {
    show();
    act(() => api?.push("warning", "Updates have stalled", undefined, 0));
    await screen.findByText("Updates have stalled");
    await waitFor(() => expect(api?.notices).toHaveLength(0), { timeout: 6000 });
  }, 8000);

  // A relevant next step on the island (owner, 26 Nov 2026): one button, and it does what it says.
  it("shows a notice's next step as its one button, and pressing it runs it", async () => {
    show();
    const printBill = vi.fn();
    act(() => api?.push("success", "Sale voucher saved", "Bill No. 1045", undefined, { label: "Print bill", onClick: printBill }));
    const button = await screen.findByRole("button", { name: "Print bill" });
    act(() => { fireEvent.click(button); });
    expect(printBill).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});
