import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { copy } from "../../config/copy";
import { NotificationsProvider, useNotifications } from "../../state/NotificationsContext";
import { NotificationCenter } from "./NotificationCenter";

// The notice island, our own (owner, 27 Nov 2026): the newest notice is the one shown, saying its kind in a word and
// how many wait; it closes by itself after four seconds (held while pointed at), with × and its one next step.

let api: ReturnType<typeof useNotifications> | null = null;
const Grab: React.FC = () => { api = useNotifications(); return null; };

const show = () => render(<NotificationsProvider><Grab /><NotificationCenter /></NotificationsProvider>);
const region = () => screen.getByRole("region", { name: copy.notices.regionLabel });

describe("NotificationCenter as an island", () => {
  it("shows the newest, says how many wait, and the next comes back when it goes", async () => {
    show();
    act(() => {
      api?.push("warning", "First", undefined, 0);
      api?.push("error", "Second", "It may have been removed.", 0);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(`${copy.notices.kinds.error}Second`);
    expect(within(region()).getByText(copy.notices.waiting(1))).toBeInTheDocument();
    expect(within(region()).queryByText("First")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.notices.close("Second") }));
    expect(await within(region()).findByText("First")).toBeInTheDocument();
    expect(within(region()).queryByText(copy.notices.waiting(1))).toBeNull();
  });

  it("closes by itself after four seconds, even one pushed to stay, but not while it is held", async () => {
    show();
    act(() => api?.push("warning", "Updates have stalled", undefined, 0));
    await waitFor(() => expect(api?.notices).toHaveLength(0), { timeout: 6000 });

    vi.useFakeTimers();
    try {
      act(() => api?.push("info", "Held", undefined, 0));
      const island = screen.getByText("Held").closest(".island-content") as HTMLElement;
      act(() => { vi.advanceTimersByTime(1000); fireEvent.mouseEnter(island); vi.advanceTimersByTime(10_000); });
      expect(api?.notices).toHaveLength(1);
      act(() => { fireEvent.mouseLeave(island); vi.advanceTimersByTime(3500); });
      expect(api?.notices).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("shows a notice's next step as a button: pressing it runs it and closes the island", async () => {
    show();
    const printBill = vi.fn();
    act(() => api?.push("success", "Sale voucher saved", "Bill No. 1045", undefined, { label: "Print bill", onClick: printBill }));
    fireEvent.click(screen.getByRole("button", { name: "Print bill" }));
    expect(printBill).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api?.notices).toHaveLength(0));
  });
});

describe("the island's sound", () => {
  it("chimes once for each new notice, in its kind, and not again when one waiting behind comes back", async () => {
    const sound = await import("./noticeSound");
    const played = vi.spyOn(sound, "playNoticeSound").mockImplementation(() => undefined);
    try {
      show();
      act(() => api?.push("warning", "First", undefined, 0));
      act(() => api?.push("success", "Second", undefined, 0));
      expect(played.mock.calls.map(([kind]) => kind)).toEqual(["warning", "success"]);
      fireEvent.click(screen.getByRole("button", { name: copy.notices.close("Second") }));
      expect(await within(region()).findByText("First")).toBeInTheDocument();
      expect(played).toHaveBeenCalledTimes(2);
    } finally {
      played.mockRestore();
    }
  });
});
