import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsProvider, useNotifications } from "../../state/NotificationsContext";
import { SalariesPage } from "./SalariesPage";

// THE SALARIES PAGE (owner, 27 Nov 2026: "add a new card on dashboard named as Salaries. in this page put an add
// Employee Button ... pop up appears to add Employee set its salary"). Asserted in words (R18), synthetic people only.

const employee = (overrides: Record<string, unknown> = {}) => ({
  id: "e1", name: "SYNTHETIC ALI", work: "CUTTING", phone: "0300-0000001", monthlySalaryPaisa: 2_500_000, joinedOn: "2026-11-01",
  status: "ACTIVE", createdAt: "2026-11-27T09:00:00.000Z", ...overrides,
});
const ACCOUNTS_HERE = [{ domain: "ACCOUNTS", canWrite: true, reason: null, holderLabel: null }];
const ACCOUNTS_ELSEWHERE = [{ domain: "ACCOUNTS", canWrite: false, reason: "HELD_ELSEWHERE", holderLabel: "PC1 - ACCOUNTS" }];

const Notices: React.FC = () => <ul aria-label="notices">{useNotifications().notices.map((notice) => <li key={notice.id}>{notice.title}</li>)}</ul>;

let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  api = {
    getWriteLeases: vi.fn().mockResolvedValue(ACCOUNTS_HERE),
    listEmployees: vi.fn().mockResolvedValue({ accepted: true, employees: [] }),
    createEmployee: vi.fn(),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

const show = () => render(<NotificationsProvider><SalariesPage /><Notices /></NotificationsProvider>);
const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("Salaries", () => {
  it("says there are no employees yet, and adds one with a salary through the pop-up", async () => {
    const added = employee({ id: "e2", name: "SYNTHETIC BABAR", work: null, phone: null, joinedOn: null, monthlySalaryPaisa: 3_000_050 });
    api.createEmployee!.mockResolvedValue({ accepted: true, employee: added });
    show();
    expect(await screen.findByText("No employees yet")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add an employee" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/^Name/)).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Add employee" }));
    expect(within(dialog).getByText(/Type the employee's name/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Type the monthly salary/)).toBeInTheDocument();
    expect(api.createEmployee).not.toHaveBeenCalled();

    type(/^Name/, "Synthetic Babar");
    type(/^Monthly salary/, "30000.50");
    api.listEmployees!.mockResolvedValue({ accepted: true, employees: [added] });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add employee" }));
    expect(api.createEmployee).toHaveBeenCalledWith({ name: "Synthetic Babar", work: "", phone: "", monthlySalary: "30000.50", joinedOn: "" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(screen.getByRole("list", { name: "notices" })).getByText("SYNTHETIC BABAR added")).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Employees and their monthly salaries" });
    expect(within(table).getByText("SYNTHETIC BABAR")).toBeInTheDocument();
    expect(within(table).getByText("Rs 30,000.50")).toBeInTheDocument();
  });

  it("lists employees with what they do and the month's total of those still working", async () => {
    api.listEmployees!.mockResolvedValue({
      accepted: true,
      employees: [employee(), employee({ id: "e2", name: "SYNTHETIC KAMRAN", monthlySalaryPaisa: 3_000_000 }), employee({ id: "e3", name: "SYNTHETIC OLD", status: "LEFT", monthlySalaryPaisa: 9_000_000 })],
    });
    show();
    const table = await screen.findByRole("table", { name: "Employees and their monthly salaries" });
    expect(within(table).getAllByText("CUTTING")).toHaveLength(3);
    expect(within(table).getByText("Left")).toBeInTheDocument();
    expect(screen.getByText("2 employees")).toBeInTheDocument();
    expect(screen.getByText("Rs 55,000")).toBeInTheDocument();
  });

  it("shows the main process's refusal in the pop-up and keeps what was typed", async () => {
    api.createEmployee!.mockResolvedValue({ accepted: false, reason: "SYNTHETIC ALI is already an employee. Add something to tell them apart, like SYNTHETIC ALI (CUTTING)." });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Add an employee" }));
    type(/^Name/, "Synthetic Ali");
    type(/^Monthly salary/, "25000");
    await userEvent.click(screen.getByRole("button", { name: "Add employee" }));
    expect(await screen.findByText(/already an employee/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Synthetic Ali");
  });

  it("reads everywhere, and adds only where the accounts are written", async () => {
    api.getWriteLeases!.mockResolvedValue(ACCOUNTS_ELSEWHERE);
    api.listEmployees!.mockResolvedValue({ accepted: true, employees: [employee()] });
    show();
    expect(await screen.findByText("SYNTHETIC ALI")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add an employee" })).toBeDisabled());
  });

  it("says when the employees could not be read, and Retry reads them again", async () => {
    api.listEmployees!.mockResolvedValueOnce({ accepted: false, reason: "The employees could not be loaded. Try again." }).mockResolvedValue({ accepted: true, employees: [employee()] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: /retry/i }));
    expect(await screen.findByText("SYNTHETIC ALI")).toBeInTheDocument();
  });

  it("refuses a reply that is not an employee list", async () => {
    api.listEmployees!.mockResolvedValue({ accepted: true, employees: [{ id: "e1", name: "X", monthlySalaryPaisa: "lots" }] });
    show();
    expect(await screen.findByText(/The employees could not be read/)).toBeInTheDocument();
  });
});
