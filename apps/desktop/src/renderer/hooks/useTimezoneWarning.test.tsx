import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { NotificationsProvider, useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";
import { useTimezoneWarning } from "./useTimezoneWarning";

// A new PC arrives set to whatever zone the shop left it on, and nothing said so.

const Signed = ({ userId, zone }: { userId: string | null; zone: () => string }) => {
  useTimezoneWarning(userId, zone);
  const { notices } = useNotifications();
  return (
    <ul>
      {notices.map((notice) => (
        <li key={notice.id}>{`${notice.kind}: ${notice.title}: ${notice.message ?? ""}`}</li>
      ))}
    </ul>
  );
};

const inProvider = (userId: string | null, zone: () => string) => (
  <NotificationsProvider>
    <Signed userId={userId} zone={zone} />
  </NotificationsProvider>
);

const warnings = () => screen.queryAllByText(new RegExp(copy.timezone.wrongTitle));

describe("the time zone warning", () => {
  it("says nothing on a computer set to Pakistan time", () => {
    render(inProvider("u-1", () => "Asia/Karachi"));
    expect(warnings()).toHaveLength(0);
  });

  it("names the zone the computer is on, as a warning, once someone signs in", () => {
    render(inProvider("u-1", () => "America/Los_Angeles"));
    expect(screen.getByText(/^warning: /)).toHaveTextContent("America/Los_Angeles");
    expect(screen.getByText(/^warning: /)).toHaveTextContent("Pakistan Standard Time");
  });

  it("a zone an hour off is still the wrong zone", () => {
    render(inProvider("u-1", () => "Asia/Dubai"));
    expect(warnings()).toHaveLength(1);
  });

  it("waits for a sign-in: nobody is there to read it before that", () => {
    const zone = vi.fn(() => "UTC");
    render(inProvider(null, zone));
    expect(zone).not.toHaveBeenCalled();
    expect(warnings()).toHaveLength(0);
  });

  it("does not raise it again for the same person, and does for the next one", () => {
    const zone = () => "UTC";
    const { rerender } = render(inProvider("u-1", zone));
    rerender(inProvider("u-1", zone));
    expect(warnings()).toHaveLength(1);
    rerender(inProvider("u-2", zone));
    expect(warnings()).toHaveLength(2);
  });

  it("is raised once even when React runs the effect twice", () => {
    render(<React.StrictMode>{inProvider("u-1", () => "UTC")}</React.StrictMode>);
    expect(warnings()).toHaveLength(1);
  });

  it("stays until it is dismissed: it is a setup task, not a passing event", () => {
    vi.useFakeTimers();
    try {
      render(inProvider("u-1", () => "UTC"));
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(warnings()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
