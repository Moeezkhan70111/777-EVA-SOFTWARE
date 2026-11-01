import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberSection } from "./MemberSection";
import type { Member } from "./types";
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

const show = (members: Member[], onReview = vi.fn().mockResolvedValue(undefined), onSaveAccess = vi.fn().mockResolvedValue(true)) => {
  render(
    <NotificationsProvider>
      <SessionProvider user={OWNER} token="session-owner">
        <MemberSection
          members={members}
          roleOptions={ROLES}
          onPermissions={vi.fn()}
          onRevoke={vi.fn()}
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
    const onSaveAccess = vi.fn().mockResolvedValue(true);
    show([member({ roleCode: "munshi", roleName: "Munshi", jobRole: "Munshi", additionalPermissions: ["logs"] })], undefined, onSaveAccess);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "store");
    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onSaveAccess).toHaveBeenCalledTimes(1);
    expect(onSaveAccess).toHaveBeenCalledWith("p-ali", { roleCode: "store", jobRole: "Store", authorityLevel: 10, extraPermissions: ["logs"] });
    expect(await screen.findByText("Changes saved")).toBeInTheDocument();
  });

  it("a refused Save does not say it saved", async () => {
    const onSaveAccess = vi.fn().mockResolvedValue(false);
    show([member({})], undefined, onSaveAccess);
    await userEvent.click(screen.getByRole("button", { name: /Ali/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onSaveAccess).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Changes saved")).not.toBeInTheDocument());
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
