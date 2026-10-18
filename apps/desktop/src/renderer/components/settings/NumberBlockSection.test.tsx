import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NumberBlockSection } from "./NumberBlockSection";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { NumberBlockStatus } from "../../types/desktopApi";

// What Settings shows an operator about this computer's document-number range.
//
// Two recordings are offered, to an administrator only, and both are one-time. ADOPTION takes no
// range: the main process proves from this computer's own documents that it is the machine that
// holds them. ASSIGNMENT takes one of the ranges the data layer offers, for a second computer,
// and is confirmed against the numbers it will create -- because the only record of which
// machine holds which range is the factory's own, and no computer can read it.
//
// The panel must never work a range out for itself: every number it shows comes from the status.

/** What the data layer offers a second computer. Exactly the shape getNumberBlockStatus returns. */
const ASSIGNABLE = [
  { block: 2, lo: 100_000, hi: 199_999 },
  { block: 3, lo: 200_000, hi: 299_999 },
  { block: 4, lo: 300_000, hi: 399_999 },
  { block: 5, lo: 400_000, hi: 499_999 },
];

const UNCONFIGURED: NumberBlockStatus = {
  block: null,
  range: null,
  confirmed: false,
  problem: "NOT_CONFIGURED",
  storedValue: null,
  adoption: { allowed: true, refusal: null, detail: "" },
  assignable: ASSIGNABLE,
};

const NEW_COMPUTER: NumberBlockStatus = {
  ...UNCONFIGURED,
  adoption: {
    allowed: false,
    refusal: "NO_EXISTING_DATA",
    detail: "This is a new installation with no numbered documents.",
  },
};

const BLOCK_TWO: NumberBlockStatus = {
  block: 2,
  range: { block: 2, lo: 100_000, hi: 199_999 },
  confirmed: true,
  problem: null,
  storedValue: null,
  adoption: { allowed: false, refusal: "ALREADY_CONFIGURED", detail: "Already recorded." },
  // Nothing is offered once a range is recorded here: a range is never reassigned.
  assignable: [],
};

const INVALID: NumberBlockStatus = {
  block: null,
  range: null,
  confirmed: true,
  problem: "INVALID",
  storedValue: "42",
  adoption: { allowed: false, refusal: "ALREADY_CONFIGURED", detail: "Already recorded." },
  // A stored range that is not one of the five is corrected at the database, not reassigned here.
  assignable: [],
};

type RecordOutcome = Promise<{
  accepted: boolean;
  range?: { block: number; lo: number; hi: number };
  reason?: string;
}>;

const api = {
  getNumberBlockStatus: vi.fn<() => Promise<NumberBlockStatus>>(),
  adoptNumberBlock: vi.fn<() => RecordOutcome>(),
  assignNumberBlock: vi.fn<(block: number) => RecordOutcome>(),
};

beforeEach(() => {
  api.getNumberBlockStatus.mockReset().mockResolvedValue(UNCONFIGURED);
  api.adoptNumberBlock.mockReset().mockResolvedValue({ accepted: true, range: { block: 1, lo: 1, hi: 99_999 } });
  api.assignNumberBlock
    .mockReset()
    .mockResolvedValue({ accepted: true, range: { block: 3, lo: 200_000, hi: 299_999 } });
  (window as unknown as { desktop: { api: typeof api } }).desktop = { api };
});

const show = (isAdmin = true) =>
  render(
    <NotificationsProvider>
      <NumberBlockSection isAdmin={isAdmin} />
    </NotificationsProvider>
  );

describe("the document-number range panel", () => {
  it("shows the range this computer holds", async () => {
    api.getNumberBlockStatus.mockResolvedValue(BLOCK_TWO);
    show();
    expect(await screen.findByText("Computer 2 of 5")).toBeInTheDocument();
    expect(screen.getByText(/100,000/)).toBeInTheDocument();
    expect(screen.getByText("Set")).toBeInTheDocument();
  });

  it("offers a computer that already holds a range no way to change it", async () => {
    // A RANGE IS NEVER REASSIGNED. Documents already carry numbers from it, so a second range
    // here would alias them. The panel offers no control at all once one is recorded.
    api.getNumberBlockStatus.mockResolvedValue(BLOCK_TWO);
    const view = show();
    await screen.findByText("Computer 2 of 5");
    expect(view.container.querySelector("input")).toBeNull();
    expect(view.container.querySelector("select")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says plainly when no range has been given, and does not pretend documents can be created", async () => {
    show();
    expect(await screen.findByText("Not set")).toBeInTheDocument();
    expect(screen.getByText(/Documents cannot be created on this computer/)).toBeInTheDocument();
  });

  it("offers the one-time assignment to an administrator, and records it once confirmed", async () => {
    show();
    const open = await screen.findByRole("button", { name: /Record This Computer As Computer 1/ });
    await userEvent.click(open);

    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Record This Computer As Computer 1/ }));

    await waitFor(() => expect(api.adoptNumberBlock).toHaveBeenCalledTimes(1));
  });

  it("does not offer the assignment to anyone but an administrator", async () => {
    show(false);
    await screen.findByText("Not set");
    expect(screen.queryByRole("button", { name: /Record This Computer/ })).toBeNull();
    expect(api.adoptNumberBlock).not.toHaveBeenCalled();
  });

  it("tells a new computer why it cannot adopt range 1, instead of offering that button", async () => {
    api.getNumberBlockStatus.mockResolvedValue(NEW_COMPUTER);
    show();
    expect(await screen.findByText(/This computer cannot be given a range here/)).toBeInTheDocument();
    expect(screen.getByText(/new installation with no numbered documents/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record This Computer As Computer 1/ })).toBeNull();
  });

  it("reports an unusable stored range, with what is stored", async () => {
    api.getNumberBlockStatus.mockResolvedValue(INVALID);
    show();
    expect(await screen.findByText("Not valid")).toBeInTheDocument();
    expect(screen.getByText(/Stored value: 42/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record This Computer/ })).toBeNull();
  });

  describe("giving a second computer its range", () => {
    const pick = async (label: RegExp): Promise<void> => {
      const select = await screen.findByLabelText("Range for this computer");
      await userEvent.selectOptions(select, within(select).getByRole("option", { name: label }));
    };

    it("offers only the ranges the data layer gave it, and no range 1", async () => {
      api.getNumberBlockStatus.mockResolvedValue(NEW_COMPUTER);
      show();
      const select = await screen.findByLabelText("Range for this computer");
      const offered = within(select)
        .getAllByRole("option")
        .map((option) => option.textContent);
      expect(offered).toEqual([
        "Choose a range",
        "Computer 2 of 5 — 100,000 – 199,999",
        "Computer 3 of 5 — 200,000 – 299,999",
        "Computer 4 of 5 — 300,000 – 399,999",
        "Computer 5 of 5 — 400,000 – 499,999",
      ]);
    });

    it("records the range that was picked, after it is confirmed against its numbers", async () => {
      api.getNumberBlockStatus.mockResolvedValue(NEW_COMPUTER);
      show();
      await pick(/Computer 3 of 5/);
      await userEvent.click(screen.getByRole("button", { name: "Record This Range" }));

      const dialog = await screen.findByRole("dialog");
      // The numbers are in front of the administrator before anything is recorded.
      expect(within(dialog).getByText("200,000 – 299,999")).toBeInTheDocument();
      expect(within(dialog).getByText(/cannot be changed in the application/)).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole("button", { name: "Record This Range" }));

      await waitFor(() => expect(api.assignNumberBlock).toHaveBeenCalledWith(3));
    });

    it("records nothing until a range is picked", async () => {
      api.getNumberBlockStatus.mockResolvedValue(NEW_COMPUTER);
      show();
      const record = await screen.findByRole("button", { name: "Record This Range" });
      expect(record).toBeDisabled();
      await userEvent.click(record);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(api.assignNumberBlock).not.toHaveBeenCalled();
    });

    it("records nothing when the confirmation is closed instead", async () => {
      api.getNumberBlockStatus.mockResolvedValue(NEW_COMPUTER);
      show();
      await pick(/Computer 4 of 5/);
      await userEvent.click(screen.getByRole("button", { name: "Record This Range" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(api.assignNumberBlock).not.toHaveBeenCalled();
    });

    it("keeps the refusal in front of the administrator rather than closing on it", async () => {
      api.getNumberBlockStatus.mockResolvedValue(NEW_COMPUTER);
      api.assignNumberBlock.mockResolvedValue({
        accepted: false,
        reason: "This computer already has a range recorded.",
      });
      show();
      await pick(/Computer 2 of 5/);
      await userEvent.click(screen.getByRole("button", { name: "Record This Range" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Record This Range" }));

      expect(await screen.findByText(/This computer already has a range recorded\./)).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("offers nothing to anyone but an administrator", async () => {
      api.getNumberBlockStatus.mockResolvedValue(NEW_COMPUTER);
      show(false);
      await screen.findByText("Not set");
      expect(screen.queryByLabelText("Range for this computer")).toBeNull();
      expect(screen.queryByRole("button", { name: "Record This Range" })).toBeNull();
    });

    it("says that the factory's own record is the authority, not the application", async () => {
      api.getNumberBlockStatus.mockResolvedValue(NEW_COMPUTER);
      show();
      expect(await screen.findByText(/Each computer must have a different range/)).toBeInTheDocument();
      expect(
        screen.getByText(/Nothing in the application can check which range another computer is using/)
      ).toBeInTheDocument();
    });
  });

  it("offers a retry when the range cannot be read", async () => {
    api.getNumberBlockStatus.mockRejectedValueOnce(new Error("no handler"));
    show();
    const retry = await screen.findByRole("button", { name: "Retry" });

    api.getNumberBlockStatus.mockResolvedValue(BLOCK_TWO);
    await userEvent.click(retry);
    expect(await screen.findByText("Computer 2 of 5")).toBeInTheDocument();
  });
});
