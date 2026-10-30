// The Store header's right-hand side for a store operator (0.4.1): the bell with their own
// notifications, and the portrait that opens the usual profile menu.

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { StoreHeaderActions } from "./StoreHeaderActions";
import type { AuthUser } from "../../../types/desktopApi";
import type { UserNotification } from "../../users/types";

const USER = { id: "u-3", username: "store-op", role: "USER", accessStatus: "APPROVED", permissions: ["store-scanning"] } as unknown as AuthUser;
const PROGRAM: UserNotification = {
  id: "n-1", title: "Program MP-000012 is ready", message: "Upper for DC3 7/10", createdAt: "2026-10-31T05:00:00.000Z", readAt: null,
};
const READ: UserNotification = { ...PROGRAM, id: "n-2", title: "Yesterday's program", readAt: "2026-10-30T09:00:00.000Z" };

const renderActions = (notifications: UserNotification[], handlers: Partial<React.ComponentProps<typeof StoreHeaderActions>> = {}) =>
  render(
    <StoreHeaderActions
      user={USER}
      notifications={notifications}
      onNotificationClick={vi.fn()}
      savedProfiles={[]}
      onSwitchProfile={vi.fn()}
      onAddAccount={vi.fn()}
      onLogout={vi.fn()}
      onChangePassword={vi.fn()}
      onProfile={vi.fn()}
      {...handlers}
    />
  );

describe("StoreHeaderActions", () => {
  it("counts only unread notifications on the bell, and opens one on click", () => {
    const onNotificationClick = vi.fn();
    renderActions([PROGRAM, READ], { onNotificationClick });
    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(bell).toHaveTextContent("1");
    fireEvent.click(bell);
    fireEvent.click(screen.getByRole("button", { name: /Program MP-000012 is ready/ }));
    expect(onNotificationClick).toHaveBeenCalledWith(PROGRAM);
  });

  it("shows no badge, and says so in words, when there is nothing", () => {
    renderActions([]);
    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(bell).toHaveTextContent("");
    fireEvent.click(bell);
    expect(screen.getByText("Nothing new.")).toBeInTheDocument();
  });

  it("draws the profile as the header's portrait, opening the usual menu", () => {
    const onLogout = vi.fn();
    renderActions([], { onLogout });
    const avatar = screen.getByRole("button", { name: "User Profile" });
    expect(within(avatar).getByRole("presentation")).toHaveAttribute("src", "./assets/store/avatar.png");
    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    expect(onLogout).toHaveBeenCalled();
  });
});
