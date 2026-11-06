// The top right of every screen: the bell with the user's own notifications (and an
// administrator's requests), and the portrait that opens the usual profile menu. The Store page
// header and the app's top bar both draw this one component.

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { HeaderActions } from "./HeaderActions";
import { AccessRequestList, pendingRequestCount } from "./AccessRequestList";
import type { AuthUser } from "../../types/desktopApi";
import type { UserNotification } from "../../features/users/types";

const USER = { id: "u-3", username: "store-op", role: "USER", accessStatus: "APPROVED", permissions: ["store-scanning"] } as unknown as AuthUser;
const PROGRAM: UserNotification = {
  id: "n-1", title: "Program MP-000012 is ready", message: "Upper for DC3 7/10", createdAt: "2026-10-31T05:00:00.000Z", readAt: null,
};
const READ: UserNotification = { ...PROGRAM, id: "n-2", title: "Yesterday's program", readAt: "2026-10-30T09:00:00.000Z" };

const renderActions = (notifications: UserNotification[], handlers: Partial<React.ComponentProps<typeof HeaderActions>> = {}) =>
  render(
    <HeaderActions
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

describe("HeaderActions", () => {
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

  it("closes the panel on a click anywhere else, and on Escape", () => {
    renderActions([PROGRAM]);
    const bell = screen.getByRole("button", { name: "Notifications" });
    fireEvent.click(bell);
    fireEvent.mouseDown(screen.getByText("Program MP-000012 is ready"));
    expect(screen.getByText("Program MP-000012 is ready")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Program MP-000012 is ready")).not.toBeInTheDocument();

    fireEvent.click(bell);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Program MP-000012 is ready")).not.toBeInTheDocument();
  });

  it("counts an administrator's pending requests on the bell and lists them under the notifications", () => {
    const onReviewPermissionRequest = vi.fn();
    const accessRequests = [{ id: "ar-1", username: "rookie", status: "PENDING" as const }];
    const permissionRequests = [
      { id: "pr-1", userId: "u-9", username: "aslam", permissionCode: "stock", reason: null, status: "PENDING" as const },
      { id: "pr-2", userId: "u-8", username: "bilal", permissionCode: "logs", reason: null, status: "APPROVED" as const },
    ];
    renderActions([PROGRAM], {
      requests: {
        count: pendingRequestCount(accessRequests, permissionRequests),
        panel: (
          <AccessRequestList
            isAdmin
            accessRequests={accessRequests}
            roleOptions={[]}
            onReviewAccessRequest={vi.fn()}
            permissionRequests={permissionRequests}
            onReviewPermissionRequest={onReviewPermissionRequest}
          />
        ),
      },
    });
    const bell = screen.getByRole("button", { name: "Notifications" });
    // One unread notification and two pending requests.
    expect(bell).toHaveTextContent("3");
    fireEvent.click(bell);
    expect(screen.getByText("Access Requests")).toBeInTheDocument();
    expect(screen.getByText("rookie")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onReviewPermissionRequest).toHaveBeenCalledWith("pr-1", "APPROVED");
  });
});
