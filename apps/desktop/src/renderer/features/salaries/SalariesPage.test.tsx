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

  it("suggests the work already given to someone when adding the next", async () => {
    api.listEmployees!.mockResolvedValue({ accepted: true, employees: [employee(), employee({ id: "e2", name: "SYNTHETIC KAMRAN", work: "PACKING" })] });
    show();
    await screen.findByText("SYNTHETIC KAMRAN");
    await userEvent.click(screen.getByRole("button", { name: "Add an employee" }));
    const options = Array.from(document.querySelectorAll("#sal-work-list option")).map((option) => option.getAttribute("value"));
    expect(options).toEqual(["CUTTING", "PACKING"]);
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

// Owner, 27 Nov 2026: "make the employee row clickable ... opens the card of employee. with its details. also put a
// button in that card as increment. to increment the salary by percentage or a fixed value".
const detail = (overrides: Record<string, unknown> = {}) => ({
  ...employee(),
  history: [{ id: "h1", kind: "START", amount: null, fromPaisa: null, toPaisa: 2_500_000, effectiveOn: "2026-11-01", note: null, createdBy: "owner" }],
  ...overrides,
});

describe("An employee's card", () => {
  beforeEach(() => {
    api.listEmployees!.mockResolvedValue({ accepted: true, employees: [employee()] });
    api.getEmployee = vi.fn().mockResolvedValue({ accepted: true, employee: detail() });
    api.incrementEmployeeSalary = vi.fn();
  });

  it("opens from the row with the details and the salary history", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Open SYNTHETIC ALI's card" }));
    const card = await screen.findByRole("dialog");
    expect(api.getEmployee).toHaveBeenCalledWith("e1");
    expect(within(card).getByText(/Working/)).toBeInTheDocument();
    expect(within(card).getByRole("region", { name: "Monthly salary" })).toHaveTextContent("Rs 25,000");
    expect(card.querySelector(".member-modal-actions .btn-secondary")).toHaveTextContent("Close");
    expect(within(card).getByText("0300-0000001")).toBeInTheDocument();
    const history = within(card).getByRole("region", { name: "SYNTHETIC ALI's salary history" });
    expect(within(history).getByText("Started at")).toBeInTheDocument();
    expect(within(history).getByRole("table")).toHaveTextContent("Rs 25,000");
  });

  it("raises the salary by a percentage, showing the new figure before it is saved", async () => {
    const raised = detail({
      monthlySalaryPaisa: 2_750_000,
      history: [...detail().history, { id: "h2", kind: "PERCENT", amount: 1000, fromPaisa: 2_500_000, toPaisa: 2_750_000, effectiveOn: "2026-12-01", note: "Yearly", createdBy: "owner" }],
    });
    api.incrementEmployeeSalary!.mockResolvedValue({ accepted: true, employee: raised });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Open SYNTHETIC ALI's card" }));
    await userEvent.click(await screen.findByRole("button", { name: "Increment SYNTHETIC ALI's salary" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Percentage/ }), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/^New salary from/), { target: { value: "2026-12-01" } });
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: "Yearly" } });
    const equation = screen.getByRole("status", { name: "The new salary" });
    expect(equation).toHaveTextContent("NowRs 25,000");
    expect(equation).toHaveTextContent("IncrementRs 2,500");
    expect(equation).toHaveTextContent("New salaryRs 27,500");
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save increment" }));
    expect(api.incrementEmployeeSalary).toHaveBeenCalledWith({ employeeId: "e1", kind: "PERCENT", value: "10", effectiveOn: "2026-12-01", note: "Yearly", expectedSalaryPaisa: 2_500_000 });
    const history = await screen.findByRole("region", { name: "SYNTHETIC ALI's salary history" });
    expect(within(history).getByText("+10%")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "notices" })).getByText("SYNTHETIC ALI's salary raised")).toBeInTheDocument();
  });

  it("raises it by a fixed amount, and a slip is said under its field", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Open SYNTHETIC ALI's card" }));
    await userEvent.click(await screen.findByRole("button", { name: "Increment SYNTHETIC ALI's salary" }));
    await userEvent.click(screen.getByRole("button", { name: "Fixed amount (Rs)" }));
    expect(screen.getByRole("button", { name: "Fixed amount (Rs)" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Save increment" }));
    expect(screen.getByText(/Type the increment in rupees/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /^Amount/ }), { target: { value: "1500" } });
    expect(screen.getByRole("status", { name: "The new salary" })).toHaveTextContent("New salaryRs 26,500");
    expect(api.incrementEmployeeSalary).not.toHaveBeenCalled();
  });

  it("Back leaves the increment and returns to the history, the card still open", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Open SYNTHETIC ALI's card" }));
    await userEvent.click(await screen.findByRole("button", { name: "Increment SYNTHETIC ALI's salary" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "SYNTHETIC ALI's salary history" })).toBeInTheDocument();
  });

  it("offers Increment only where the accounts are written", async () => {
    api.getWriteLeases!.mockResolvedValue(ACCOUNTS_ELSEWHERE);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Open SYNTHETIC ALI's card" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Increment SYNTHETIC ALI's salary" })).toBeDisabled());
    expect(within(screen.getByRole("dialog")).getByText(/PC1 - ACCOUNTS/)).toBeInTheDocument();
  });
});
