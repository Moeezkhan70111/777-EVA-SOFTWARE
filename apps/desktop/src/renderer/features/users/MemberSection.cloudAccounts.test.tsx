import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberSection } from "./MemberSection";
import type { Member } from "./types";
import { describePerm } from "./permissions";
import { SessionProvider } from "../auth/SessionContext";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { copy } from "../../config/copy";
import type { AuthUser } from "../../types/desktopApi";

// The member list and details under cloud accounts (docs/41): approving someone whose account moved
// up starts from what they had (cloud 023), and an admin can make, or unmake, another admin.

const OWNER: AuthUser = { id: "p-owner", username: "Owner", role: "ADMIN", accessStatus: "APPROVED", permissions: [], lastLoginAt: null };
const ROLES = [
  { code: "munshi", name: "Munshi", permissions: ["stock"] },
  { code: "store", name: "Store", permissions: ["store-scanning"] },
];

const member = (overrides: Partial<Member>): Member => ({
  id: "p-ali", username: "Ali", role: "USER", jobRole: "", authorityLevel: 10, accessStatus: "APPROVED",
  permissions: [], lastLoginAt: null, accessRequestId: null, roleCode: null, roleName: null, additionalPermissions: [], ...overrides,
});

const api = { getAccountsStatus: vi.fn(), setMemberAdmin: vi.fn(), resetMemberPassword: vi.fn() };

beforeEach(() => {
  api.getAccountsStatus.mockReset().mockResolvedValue({ mode: "CLOUD", cloudConfigured: true, deviceId: "dev-pc2", switchReady: true });
  api.setMemberAdmin.mockReset().mockResolvedValue({ accepted: true });
  (window as unknown as { desktop: { api: typeof api } }).desktop = { api };
});

const show = (
  members: Member[],
  onReview = vi.fn().mockResolvedValue(undefined),
  onSaveAccess = vi.fn().mockResolvedValue(true),
  access = { onRevoke: vi.fn().mockResolvedValue(null), onRestore: vi.fn().mockResolvedValue(null) },
) => {
  render(
    <NotificationsProvider>
      <SessionProvider user={OWNER} token="session-owner">
        <MemberSection
          members={members}
          roleOptions={ROLES}
          onPermissions={vi.fn()}
          onRevoke={access.onRevoke}
          onRestore={access.onRestore}
          onReview={onReview}
          onSaveAccess={onSaveAccess}
        />
      </SessionProvider>
    </NotificationsProvider>
  );
  return onReview;
};

describe("Save is one change per press (rehearsal, 2 Nov)", () => {
  it("sends the role, its name as job role, authority and extras together, once", async () => {
    const onSaveAccess = vi.fn().mockResolvedValue({
      screensStillOpen: [],
      stored: { roleCode: "store", jobRole: "Store", authorityLevel: 10, extraPermissions: ["logs"] },
      fields: [{ field: "ROLE", outcome: "CHANGED" }],
    });
    show([member({ roleCode: "munshi", roleName: "Munshi", jobRole: "Munshi", additionalPermissions: ["logs"] })], undefined, onSaveAccess);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "store");
    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onSaveAccess).toHaveBeenCalledTimes(1);
    expect(onSaveAccess).toHaveBeenCalledWith("p-ali", { roleCode: "store", jobRole: "Store", authorityLevel: 10, extraPermissions: ["logs"] });
    expect(await screen.findByText("Changes saved")).toBeInTheDocument();
  });

  it("a refused Save does not say it saved", async () => {
    const onSaveAccess = vi.fn().mockResolvedValue(null);
    show([member({})], undefined, onSaveAccess);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onSaveAccess).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Changes saved")).not.toBeInTheDocument());
  });
});

describe("taking a role away (rehearsal, 5 Nov)", () => {
  it("sends no role, and shows what the save reports", async () => {
    const onSaveAccess = vi.fn().mockResolvedValue({
      screensStillOpen: [],
      stored: { roleCode: null, jobRole: "", authorityLevel: 10, extraPermissions: [] },
      fields: [{ field: "ROLE", outcome: "CHANGED" }, { field: "JOB_ROLE", outcome: "CHANGED" }],
    });
    show([member({ roleCode: "munshi", roleName: "Munshi", jobRole: "Munshi" })], undefined, onSaveAccess);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "");
    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onSaveAccess.mock.calls[0]?.[1]).toMatchObject({ roleCode: null });
    expect(await screen.findByText("Role removed")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("a role the save did not take goes back to what the person still has, and says so", async () => {
    const onSaveAccess = vi.fn().mockResolvedValue({
      screensStillOpen: [],
      stored: { roleCode: "munshi", jobRole: "Munshi", authorityLevel: 10, extraPermissions: [] },
      fields: [{ field: "ROLE", outcome: "NOT_SAVED" }],
    });
    show([member({ roleCode: "munshi", roleName: "Munshi", jobRole: "Munshi" })], undefined, onSaveAccess);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "");
    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("still Munshi");
    expect(screen.getByRole("combobox")).toHaveValue("munshi");
    expect(screen.queryByText("Changes saved")).not.toBeInTheDocument();
  });
});

describe("approving someone whose account moved up", () => {
  it("starts from the role and access they had, says so, and approves with it", async () => {
    const onReview = show([
      member({
        accessStatus: "PENDING",
        accessRequestId: "p-ali",
        suggestedAccess: { roleCode: "munshi", extraPermissions: ["logs"], jobRole: "Munshi", authorityLevel: 20 },
      }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    expect(screen.getByText(copy.cloudAccounts.suggestedNote)).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("munshi");
    await userEvent.click(screen.getByRole("button", { name: "Approve Access" }));
    expect(onReview).toHaveBeenCalledWith("p-ali", "APPROVED", expect.arrayContaining(["logs", "stock"]), "munshi");
  });

  it("shows as Additional Access only the screens beyond the suggested role, which is all approving stores", async () => {
    // A local approval stored the role's screens among the extras; they are the role's, not extra.
    const onReview = show([
      member({
        accessStatus: "PENDING",
        accessRequestId: "p-ali",
        suggestedAccess: { roleCode: "munshi", extraPermissions: ["stock", "logs"], jobRole: "Munshi", authorityLevel: 10 },
      }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    expect(screen.getByText(`+ ${describePerm("logs")}`)).toBeInTheDocument();
    expect(screen.queryByText(`+ ${describePerm("stock")}`)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve Access" }));
    expect(onReview).toHaveBeenCalledWith("p-ali", "APPROVED", expect.arrayContaining(["logs", "stock"]), "munshi");
  });

  it("someone with nothing to bring starts empty, with no note", async () => {
    show([member({ accessStatus: "PENDING", accessRequestId: "p-ali", suggestedAccess: null })]);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    expect(screen.queryByText(copy.cloudAccounts.suggestedNote)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("");
  });
});

describe("making another admin", () => {
  it("is offered for an approved member, and asks before it does anything", async () => {
    show([member({})]);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    await userEvent.click(await screen.findByRole("button", { name: copy.cloudAccounts.adminToggleMake }));
    const dialog = await screen.findByRole("dialog", { name: copy.cloudAccounts.adminMakeTitle });
    expect(api.setMemberAdmin).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: copy.cloudAccounts.adminMakeConfirm }));
    await waitFor(() => expect(api.setMemberAdmin).toHaveBeenCalledWith("session-owner", "p-ali", true));
  });

  it("an admin's rights can be taken away from their row, but not one's own", async () => {
    show([member({ id: "p-boss", username: "Boss", role: "ADMIN" }), member({ id: "p-owner", username: "Owner", role: "ADMIN" })]);
    const remove = await screen.findAllByRole("button", { name: copy.cloudAccounts.adminToggleRemove });
    expect(remove).toHaveLength(1);
    await userEvent.click(remove[0]!);
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: copy.cloudAccounts.adminRemoveConfirm }));
    await waitFor(() => expect(api.setMemberAdmin).toHaveBeenCalledWith("session-owner", "p-boss", false));
  });

  it("is not offered in local accounts", async () => {
    api.getAccountsStatus.mockResolvedValue({ mode: "LOCAL", cloudConfigured: false, deviceId: "dev", switchReady: true });
    show([member({})]);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    await waitFor(() => expect(api.getAccountsStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: copy.cloudAccounts.adminToggleMake })).not.toBeInTheDocument();
  });
});

describe("revoking access asks first, and can be undone (store rehearsal, 4 Nov)", () => {
  const access = () => ({ onRevoke: vi.fn().mockResolvedValue(null), onRestore: vi.fn().mockResolvedValue(null) });

  it("Revoke names the person and does nothing until it is confirmed", async () => {
    const calls = access();
    show([member({ roleName: "Munshi" })], undefined, undefined, calls);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    await userEvent.click(screen.getByRole("button", { name: copy.auth.revokeAccess }));

    const ask = screen.getByRole("dialog", { name: copy.auth.revokeTitle });
    expect(within(ask).getByText("Ali")).toBeInTheDocument();
    expect(within(ask).getByText("Munshi")).toBeInTheDocument();
    expect(calls.onRevoke).not.toHaveBeenCalled();

    await userEvent.click(within(ask).getByRole("button", { name: copy.auth.revokeConfirm }));
    expect(calls.onRevoke).toHaveBeenCalledTimes(1);
    expect(calls.onRevoke).toHaveBeenCalledWith("p-ali");
  });

  it("a revoked person is listed as Revoked, and is offered Restore, not Revoke", async () => {
    const calls = access();
    show([member({ accessStatus: "REVOKED", roleName: "Munshi" })], undefined, undefined, calls);
    expect(screen.getByRole("button", { name: /Ali/ })).toHaveTextContent(copy.auth.statusRevoked);

    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    expect(screen.queryByRole("button", { name: copy.auth.revokeAccess })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: copy.auth.restoreAccess }));
    const ask = screen.getByRole("dialog", { name: copy.auth.restoreTitle });
    await userEvent.click(within(ask).getByRole("button", { name: copy.auth.restoreConfirm }));

    expect(calls.onRestore).toHaveBeenCalledWith("p-ali");
    expect(calls.onRevoke).not.toHaveBeenCalled();
  });

  it("a rejected person can be restored too", async () => {
    show([member({ accessStatus: "REJECTED" })]);
    expect(screen.getByRole("button", { name: /Ali/ })).toHaveTextContent(copy.auth.statusRejected);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    expect(screen.getByRole("button", { name: copy.auth.restoreAccess })).toBeInTheDocument();
  });

  it("a refused restore says why and stays open", async () => {
    const calls = { onRevoke: vi.fn(), onRestore: vi.fn().mockResolvedValue("Sign out and sign in again while online.") };
    show([member({ accessStatus: "REVOKED" })], undefined, undefined, calls);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    await userEvent.click(screen.getByRole("button", { name: copy.auth.restoreAccess }));
    const ask = screen.getByRole("dialog", { name: copy.auth.restoreTitle });
    await userEvent.click(within(ask).getByRole("button", { name: copy.auth.restoreConfirm }));

    expect(await within(ask).findByRole("alert")).toHaveTextContent("Sign out and sign in again while online.");
    expect(screen.getByRole("dialog", { name: copy.auth.restoreTitle })).toBeInTheDocument();
  });
});
