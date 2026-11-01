import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "./AuthScreen";
import { CloudAccountsSwitchCard } from "./CloudAccountsSwitchCard";
import { CloudPasswordReset } from "./CloudPasswordReset";
import { CloudRoleCopyCard } from "./CloudRoleCopyCard";
import { RookieScreen } from "./RookieScreen";
import { SessionProvider } from "./SessionContext";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { copy } from "../../config/copy";
import type { AuthUser } from "../../types/desktopApi";

// The screens of cloud accounts (docs/41): signing in by email (and moving an old username up),
// signing up with a name, the waiting screen without its button, and the switch an admin makes by
// hand -- which must say what it will do and need a confirmation before anything happens.

const ADMIN: AuthUser = { id: "u-owner", username: "Owner", role: "ADMIN", accessStatus: "APPROVED", permissions: [], lastLoginAt: null };
const CLERK: AuthUser = { id: "u-clerk", username: "Clerk", role: "USER", accessStatus: "APPROVED", permissions: [], lastLoginAt: null };

const api = {
  getAccountsStatus: vi.fn(),
  switchToCloudAccounts: vi.fn(),
  getRoleCopyOffer: vi.fn(),
  copyRolesToCloud: vi.fn(),
  resetMemberPassword: vi.fn(),
};

beforeEach(() => {
  api.getAccountsStatus.mockReset().mockResolvedValue({ mode: "LOCAL", cloudConfigured: true, deviceId: "dev-pc2", switchReady: true });
  api.switchToCloudAccounts.mockReset();
  api.getRoleCopyOffer.mockReset().mockResolvedValue({ accepted: true, count: 0 });
  api.copyRolesToCloud.mockReset();
  api.resetMemberPassword.mockReset();
  (window as unknown as { desktop: { api: typeof api } }).desktop = { api };
});

describe("the sign-in screen", () => {
  it("in local accounts reads exactly as before", () => {
    render(<AuthScreen view="login" onSubmit={vi.fn()} onSwitch={vi.fn()} />);
    expect(screen.getByLabelText(copy.auth.username)).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.auth.cloudEmailLabel)).not.toBeInTheDocument();
  });

  it("under cloud accounts asks for an email, says an old username works the first time, then asks for the email", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<AuthScreen view="login" onSubmit={onSubmit} onSwitch={vi.fn()} cloudAccounts />);
    expect(screen.getByLabelText(copy.auth.cloudSignInLabel)).toBeInTheDocument();
    expect(screen.getByText(copy.auth.cloudSignInHint)).toBeInTheDocument();

    rerender(<AuthScreen view="login" onSubmit={onSubmit} onSwitch={vi.fn()} cloudAccounts needsEmail error="Add your email" />);
    await userEvent.type(screen.getByLabelText(copy.auth.cloudSignInLabel), "Owner");
    await userEvent.type(screen.getByLabelText(copy.auth.password), "owner1234");
    await userEvent.type(screen.getByLabelText(copy.auth.cloudEmailLabel), "boss@777.pk");
    await userEvent.click(screen.getByRole("button", { name: copy.auth.cloudMoveUpButton }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ username: "Owner", password: "owner1234", email: "boss@777.pk" }));
  });

  it("under cloud accounts signs up with a name", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AuthScreen view="signup" onSubmit={onSubmit} onSwitch={vi.fn()} cloudAccounts />);
    await userEvent.type(screen.getByLabelText(copy.auth.cloudNameLabel), "Ali");
    await userEvent.type(screen.getByLabelText(copy.auth.cloudSignInLabel), "ali@777.pk");
    await userEvent.type(screen.getByLabelText(copy.auth.password), "alipass12");
    await userEvent.type(screen.getByLabelText(copy.auth.confirmPassword), "alipass12");
    await userEvent.click(screen.getByRole("button", { name: copy.auth.signUpLink }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Ali", username: "ali@777.pk", confirmPassword: "alipass12" }));
  });
});

describe("the waiting screen", () => {
  it("in local accounts still offers the request", () => {
    render(<RookieScreen requestStatus={null} onRequest={vi.fn()} />);
    expect(screen.getByRole("button", { name: copy.auth.requestAccess })).toBeInTheDocument();
  });

  it("under cloud accounts has nothing to press: signing up was the request", () => {
    render(<RookieScreen requestStatus="PENDING" onRequest={vi.fn()} cloudAccounts />);
    expect(screen.getByText(copy.auth.cloudWaitingBody)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("the switch to cloud accounts", () => {
  const show = (user: AuthUser, onSwitched = vi.fn().mockResolvedValue(undefined)) => {
    render(
      <NotificationsProvider>
        <SessionProvider user={user} token="session-owner">
          <CloudAccountsSwitchCard onSwitched={onSwitched} />
        </SessionProvider>
      </NotificationsProvider>
    );
    return onSwitched;
  };

  const fillAndPress = async () => {
    await userEvent.type(await screen.findByLabelText(copy.cloudAccounts.emailLabel), "boss@777.pk");
    await userEvent.type(screen.getByLabelText(copy.cloudAccounts.passwordLabel), "owner1234");
    await userEvent.click(screen.getByRole("button", { name: copy.cloudAccounts.switchButton }));
  };

  it("is not offered to anyone but an admin, nor once the computer uses cloud accounts", async () => {
    show(CLERK);
    await waitFor(() => expect(api.getAccountsStatus).toHaveBeenCalled());
    expect(screen.queryByText(copy.cloudAccounts.cardTitle)).not.toBeInTheDocument();
  });

  it("in a build that cannot yet approve anyone, says so and offers no switch at all", async () => {
    api.getAccountsStatus.mockResolvedValue({ mode: "LOCAL", cloudConfigured: true, deviceId: "dev-pc2", switchReady: false });
    show(ADMIN);
    expect(await screen.findByText(copy.cloudAccounts.notReady)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.cloudAccounts.switchButton })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(copy.cloudAccounts.passwordLabel)).not.toBeInTheDocument();
  });

  it("shows the line that names the first admin, with this computer's id, before anything happens", async () => {
    show(ADMIN);
    expect(await screen.findByText(copy.cloudAccounts.sqlLine("dev-pc2"))).toBeInTheDocument();
    expect(api.switchToCloudAccounts).not.toHaveBeenCalled();
  });

  it("says plainly what it will do and switches nothing until the confirmation", async () => {
    show(ADMIN);
    await fillAndPress();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(copy.cloudAccounts.warning, { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText(copy.cloudAccounts.factOthersValue)).toBeInTheDocument();
    expect(within(dialog).getByText(copy.cloudAccounts.factWorkValue)).toBeInTheDocument();
    expect(api.switchToCloudAccounts).not.toHaveBeenCalled();
  });

  it("on confirmation switches with this session, the email and the password, and hands over the session", async () => {
    api.switchToCloudAccounts.mockResolvedValue({ accepted: true, user: ADMIN, token: "session-owner", people: 3 });
    const onSwitched = show(ADMIN);
    await fillAndPress();
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: copy.cloudAccounts.confirm }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith(ADMIN, "session-owner"));
    expect(api.switchToCloudAccounts).toHaveBeenCalledWith("session-owner", "boss@777.pk", "owner1234");
  });

  it("keeps the dialog open and says why when the main process refuses", async () => {
    api.switchToCloudAccounts.mockResolvedValue({ accepted: false, reason: "Your account is in the cloud, but it is not an approved administrator." });
    const onSwitched = show(ADMIN);
    await fillAndPress();
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: copy.cloudAccounts.confirm }));
    expect(await within(dialog).findByText(/not an approved administrator/)).toBeInTheDocument();
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it("asks for the email and password before it opens the confirmation", async () => {
    show(ADMIN);
    await userEvent.click(await screen.findByRole("button", { name: copy.cloudAccounts.switchButton }));
    expect(screen.getByRole("alert")).toHaveTextContent(copy.cloudAccounts.needsBoth);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("after the switch: copying roles up, and resetting a password", () => {
  const within_ = (node: React.ReactNode) =>
    render(
      <NotificationsProvider>
        <SessionProvider user={ADMIN} token="session-owner">
          {node}
        </SessionProvider>
      </NotificationsProvider>
    );

  it("offers to copy this computer's roles only while there are some the cloud has never seen", async () => {
    within_(<CloudRoleCopyCard />);
    await waitFor(() => expect(api.getRoleCopyOffer).toHaveBeenCalledWith("session-owner"));
    expect(screen.queryByText(copy.cloudAccounts.roleCopyTitle)).not.toBeInTheDocument();
  });

  it("copies them up on one press, then stops offering", async () => {
    api.getRoleCopyOffer.mockResolvedValue({ accepted: true, count: 8 });
    api.copyRolesToCloud.mockResolvedValue({ accepted: true });
    within_(<CloudRoleCopyCard />);
    await userEvent.click(await screen.findByRole("button", { name: copy.cloudAccounts.roleCopyButton(8) }));
    expect(api.copyRolesToCloud).toHaveBeenCalledWith("session-owner");
    await waitFor(() => expect(screen.queryByText(copy.cloudAccounts.roleCopyTitle)).not.toBeInTheDocument());
  });

  it("offers no password reset in local accounts", async () => {
    within_(<CloudPasswordReset userId="p-ali" />);
    await waitFor(() => expect(api.getAccountsStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: copy.cloudAccounts.resetPasswordButton })).not.toBeInTheDocument();
  });

  it("under cloud accounts sets a new password for that person, and says why when refused", async () => {
    api.getAccountsStatus.mockResolvedValue({ mode: "CLOUD", cloudConfigured: true, deviceId: "dev-pc2", switchReady: true });
    api.resetMemberPassword.mockResolvedValueOnce({ accepted: false, reason: "Password must be at least 8 characters and include a letter and a number." });
    within_(<CloudPasswordReset userId="p-ali" />);
    await userEvent.click(await screen.findByRole("button", { name: copy.cloudAccounts.resetPasswordButton }));
    await userEvent.type(screen.getByLabelText(copy.cloudAccounts.resetPasswordLabel), "short");
    await userEvent.click(screen.getByRole("button", { name: copy.cloudAccounts.resetPasswordConfirm }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 8 characters");
    expect(api.resetMemberPassword).toHaveBeenCalledWith("session-owner", "p-ali", "short");
  });
});
