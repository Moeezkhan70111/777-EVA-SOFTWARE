import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { OpenPrograms } from "./OpenPrograms";

// OPEN PROGRAMS (0.3.8): every program still open, whatever its date, and a delete that is hard to
// press by accident -- the reason has to be typed, and it is what is sent. The main process checks
// again that the user is an administrator and that the reason is long enough.

const OPEN = [
  { programId: "p-1", code: "MP-000001", programDate: "2026-10-12", machineName: "MACHINE 1", contractorName: "ASLAM" },
  { programId: "p-3", code: "MP-000003", programDate: "2026-10-13", machineName: "MACHINE 2", contractorName: "BABAR" },
];

type DeleteReply = { accepted: boolean; outcome: string; reason?: string };

function installApi(
  deleteMachineProgram: (programId: string, reason: string) => Promise<DeleteReply> = async () => ({ accepted: true, outcome: "CANCELLED" })
) {
  let rows = [...OPEN];
  const api = {
    listOpenMachinePrograms: vi.fn(async () => ({ accepted: true, rows })),
    deleteMachineProgram: vi.fn(async (programId: string, reason: string) => {
      const result = await deleteMachineProgram(programId, reason);
      if (result.accepted) rows = rows.filter((row) => row.programId !== programId);
      return result;
    }),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const renderList = (onDeleted = vi.fn(), options: { canDelete?: boolean; onOpenInStore?: (programId: string, mode: "receiving" | "issuing") => void } = {}) =>
  render(
    <NotificationsProvider>
      <OpenPrograms canDelete={options.canDelete ?? true} onOpenInStore={options.onOpenInStore} onDeleted={onDeleted} />
    </NotificationsProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("Open programs", () => {
  it("lists every program still open, whatever its date", async () => {
    installApi();
    renderList();
    expect(await screen.findByText("MP-000001")).toBeInTheDocument();
    expect(screen.getByText("MP-000003")).toBeInTheDocument();
  });

  it("opens a program in the Store page, in Receiving or Issuing (0.3.9)", async () => {
    installApi();
    const onOpenInStore = vi.fn();
    renderList(vi.fn(), { onOpenInStore });
    await userEvent.click(await screen.findByRole("button", { name: "Open MP-000003 in Store · Move in" }));
    expect(onOpenInStore).toHaveBeenLastCalledWith("p-3", "receiving");
    await userEvent.click(screen.getByRole("button", { name: "Open MP-000003 in Store · Move out" }));
    expect(onOpenInStore).toHaveBeenLastCalledWith("p-3", "issuing");
  });

  it("offers Delete to an administrator only", async () => {
    installApi();
    renderList(vi.fn(), { canDelete: false, onOpenInStore: vi.fn() });
    expect(await screen.findByRole("button", { name: "Open MP-000001 in Store · Move out" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete MP-000001…" })).toBeNull();
  });

  it("says so when no program is open", async () => {
    const api = installApi();
    api.listOpenMachinePrograms.mockResolvedValueOnce({ accepted: true, rows: [] });
    renderList();
    expect(await screen.findByText("No machine program is open.")).toBeInTheDocument();
  });

  it("will not delete until a reason of at least 5 characters is typed", async () => {
    const api = installApi();
    renderList();
    await userEvent.click(await screen.findByRole("button", { name: "Delete MP-000003…" }));

    const confirm = screen.getByRole("button", { name: "Delete MP-000003" });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Why is it being deleted?"), "   no ");
    expect(confirm).toBeDisabled();
    expect(api.deleteMachineProgram).not.toHaveBeenCalled();
  });

  it("deletes with the reason as typed, then takes the program off the list", async () => {
    const api = installApi();
    const onDeleted = vi.fn();
    renderList(onDeleted);
    await userEvent.click(await screen.findByRole("button", { name: "Delete MP-000003…" }));
    await userEvent.type(screen.getByLabelText("Why is it being deleted?"), "  Never ran, trial only  ");
    await userEvent.click(screen.getByRole("button", { name: "Delete MP-000003" }));

    expect(api.deleteMachineProgram).toHaveBeenCalledWith("p-3", "Never ran, trial only");
    await waitFor(() => expect(screen.queryByText("MP-000003")).toBeNull());
    expect(onDeleted).toHaveBeenCalled();
  });

  it("shows the main process's refusal and keeps the dialog open", async () => {
    installApi(async () => ({ accepted: false, outcome: "NOT_AUTHORIZED", reason: "Only an administrator can delete a machine program." }));
    renderList();
    await userEvent.click(await screen.findByRole("button", { name: "Delete MP-000001…" }));
    await userEvent.type(screen.getByLabelText("Why is it being deleted?"), "Never ran");
    await userEvent.click(screen.getByRole("button", { name: "Delete MP-000001" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Only an administrator");
    expect(screen.getByLabelText("Why is it being deleted?")).toBeInTheDocument();
  });
});
