import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSyncSection } from "./CloudSyncSection";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { CloudSyncStatus, DeadLetterEvent } from "../../types/desktopApi";

// WHAT AN ADMINISTRATOR CAN DO ABOUT CLOUD SYNC, AND WHAT NOBODY ELSE CAN.
//
// A pass writes carton identities to a shared project and the cloud log is append-only, so the
// two actions here are the only ones in the application that cannot be cleanly undone. Three
// things therefore have to hold: a non-administrator is offered neither, a computer that is not
// set up is offered neither, and a parked event moves only when it has been named explicitly
// and confirmed.
//
// A fourth thing matters just as much and is easy to lose: an UNACCEPTED pass still reports what
// did get through. Throwing those counts away would make a partial pass look like nothing.

const CONFIGURED: CloudSyncStatus = {
  configured: true,
  host: "zzdisposable.supabase.co",
  email: "device@example.invalid",
  running: false,
  queue: {
    counts: { PENDING: 3, IN_FLIGHT: 0, FAILED: 1, DEAD_LETTER: 2, SYNCED: 9 },
    pushableNow: 1,
    pushableWaiting: 1,
    notPushable: 2,
    lastSyncedAt: "2026-10-01T10:00:00.000Z",
    lastFailureAt: null,
  },
  pullCursor: 12,
};

const NOT_CONFIGURED: CloudSyncStatus = {
  configured: false,
  problems: ["ERP_SUPABASE_URL is not set", "ERP_DEVICE_PASSWORD is not set"],
  running: false,
  queue: {
    counts: { PENDING: 0, IN_FLIGHT: 0, FAILED: 0, DEAD_LETTER: 0, SYNCED: 0 },
    pushableNow: 0,
    pushableWaiting: 0,
    notPushable: 0,
    lastSyncedAt: null,
    lastFailureAt: null,
  },
  pullCursor: 0,
};

const PARKED: DeadLetterEvent = {
  outboxId: "outbox-1",
  dedupeKey: "QR_MASTER:SK9_BLACK_7/10_000001",
  aggregateType: "QR_MASTER",
  aggregateId: "SK9_BLACK_7/10_000001",
  attempts: 5,
  transientAttempts: 0,
  error: "42501:row-level security refused this device",
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:30:00.000Z",
};

const SECOND_PARKED: DeadLetterEvent = {
  ...PARKED,
  outboxId: "outbox-2",
  dedupeKey: "QR_MASTER:SK9_BLACK_7/10_000002",
  aggregateId: "SK9_BLACK_7/10_000002",
};

const api = {
  getCloudSyncStatus: vi.fn<() => Promise<CloudSyncStatus>>(),
  runCloudSync: vi.fn(),
  listDeadLetterEvents: vi.fn(),
  requeueDeadLetterEvent: vi.fn(),
};

beforeEach(() => {
  api.getCloudSyncStatus.mockReset().mockResolvedValue(CONFIGURED);
  api.runCloudSync.mockReset().mockResolvedValue({
    accepted: true,
    pushed: 2,
    fetched: 3,
    applied: 2,
    duplicates: 1,
    refused: [],
  });
  api.listDeadLetterEvents.mockReset().mockResolvedValue({ accepted: true, entries: [] });
  api.requeueDeadLetterEvent.mockReset().mockResolvedValue({ accepted: true, entry: PARKED });
  (window as unknown as { desktop: { api: typeof api } }).desktop = { api };
});

const show = (isAdmin = true) =>
  render(
    <NotificationsProvider>
      <CloudSyncSection isAdmin={isAdmin} />
    </NotificationsProvider>
  );

/** The value shown beside one label, for the read-only status rows. */
const valueOf = (label: string): string =>
  (screen.getByText(label).parentElement?.textContent ?? "").replace(label, "").trim();

describe("the cloud sync panel", () => {
  // ─── what is offered, and to whom ─────────────────────────────────────────

  it("offers no sync action on a computer that is not set up, and says what is missing", async () => {
    api.getCloudSyncStatus.mockResolvedValue(NOT_CONFIGURED);
    show();

    expect(await screen.findByText("Not set up on this computer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync Now" })).toBeNull();
    // The reasons come from the main process, which lists them by name.
    expect(screen.getByText(/ERP_SUPABASE_URL is not set/)).toBeInTheDocument();
    expect(api.runCloudSync).not.toHaveBeenCalled();
  });

  it("shows a non-administrator the status and neither action", async () => {
    api.listDeadLetterEvents.mockResolvedValue({ accepted: true, entries: [PARKED] });
    show(false);

    expect(await screen.findByText("Ready To Send")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync Now" })).toBeNull();
    expect(screen.queryByText("Parked Events")).toBeNull();
    expect(screen.queryByRole("button", { name: /Put Back/ })).toBeNull();
    // The parked list is administrator-only on the main process side, so it is never asked for.
    expect(api.listDeadLetterEvents).not.toHaveBeenCalled();
  });

  it("shows the queue, the cursor and the timestamps this computer actually recorded", async () => {
    show();
    await screen.findByText("Ready To Send");

    expect(valueOf("Ready To Send")).toBe("1");
    expect(valueOf("Waiting To Retry")).toBe("1");
    expect(valueOf("No Transport Yet")).toBe("2");
    expect(valueOf("Sent So Far")).toBe("9");
    expect(valueOf("Cloud Log Read To")).toBe("12");
    // A failure that never happened is said plainly, not dressed up as a time.
    expect(valueOf("Last Failure")).toBe("Never");
    expect(valueOf("Last Sent")).not.toBe("Never");
  });

  // ─── running a pass ───────────────────────────────────────────────────────

  it("runs a pass and reports what went", async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Sync Now" }));

    expect(api.runCloudSync).toHaveBeenCalledTimes(1);
    // Asserted on the panel, not the toast: NotificationsProvider supplies context only and
    // renders no markup, so a notification never reaches the DOM in a test.
    //
    // "Sent This Pass" is the pass's own label, distinct from the queue's "Sent So Far" -- so
    // this needs no disambiguation between two rows that once shared a name.
    expect(await screen.findByText("Sent This Pass")).toBeInTheDocument();
    expect(valueOf("Sent This Pass")).toBe("2");
    expect(valueOf("Applied")).toBe("2");
    // Status and the parked list are read again, so the screen is not stale.
    expect(api.getCloudSyncStatus).toHaveBeenCalledTimes(2);
    expect(api.listDeadLetterEvents).toHaveBeenCalledTimes(2);
  });

  it("keeps the counts of a pass that was refused part-way through", async () => {
    api.runCloudSync.mockResolvedValue({
      accepted: false,
      reason: "the cloud could not be reached",
      pushed: 1,
      applied: 0,
      duplicates: 0,
      outbox: { PENDING: 4 },
    });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Sync Now" }));

    // THE POINT OF THIS TEST: not accepted, and the one carton that did go is still reported.
    expect(await screen.findByText("the cloud could not be reached")).toBeInTheDocument();
    expect(valueOf("Sent This Pass")).toBe("1");
    // The queue's own row keeps its own meaning and its own label.
    expect(screen.getByText("Sent So Far")).toBeInTheDocument();
  });

  it("tells a deferral apart from a refusal", async () => {
    api.runCloudSync.mockResolvedValue({
      accepted: true,
      pushed: 0,
      applied: 0,
      duplicates: 0,
      refused: [{ reason: "UNSUPPORTED_AGGREGATE_TYPE:DISPATCH_EVENT" }],
      waitingFor: "UNKNOWN_PRODUCT_VARIANT:variant-1",
    });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Sync Now" }));

    // A deferral is normal and heals itself; a refusal needs someone to act. Different lines,
    // and now different labels -- neither borrows a queue label that means something else.
    expect(await screen.findByText("Deferred")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for something that has not arrived yet/)).toBeInTheDocument();
    expect(screen.getByText("Refused By The Cloud")).toBeInTheDocument();
    expect(screen.getByText("1 event the cloud will not accept")).toBeInTheDocument();
    // The queue rows still say what they always said.
    expect(screen.getByText("Waiting To Retry")).toBeInTheDocument();
    expect(screen.getByText("Parked (Dead Letter)")).toBeInTheDocument();
  });

  it("will not start a second pass while one is running on this computer", async () => {
    api.getCloudSyncStatus.mockResolvedValue({ ...CONFIGURED, running: true });
    show();

    expect(await screen.findByText("A sync is running on this computer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync Now" })).toBeDisabled();
  });

  it("disables the button while a pass of its own is in flight", async () => {
    let release = (): void => undefined;
    api.runCloudSync.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ accepted: true, pushed: 0, applied: 0, duplicates: 0, refused: [] });
        })
    );
    const user = userEvent.setup();
    show();
    const button = await screen.findByRole("button", { name: "Sync Now" });
    await user.click(button);

    await waitFor(() => expect(screen.getByRole("button", { name: "Syncing…" })).toBeDisabled());
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sync Now" })).toBeEnabled());
    expect(api.runCloudSync).toHaveBeenCalledTimes(1);
  });

  it("survives a status read that fails, and offers a retry", async () => {
    api.getCloudSyncStatus.mockRejectedValueOnce(new Error("Your session has expired."));
    const user = userEvent.setup();
    show();

    // getCloudSyncStatus throws rather than answering with a refusal shape; the panel degrades.
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("button", { name: "Sync Now" })).toBeNull();

    api.getCloudSyncStatus.mockResolvedValue(CONFIGURED);
    await user.click(retry);
    expect(await screen.findByText("Ready To Send")).toBeInTheDocument();
  });

  it("ignores a status answer whose shape it cannot trust", async () => {
    api.getCloudSyncStatus.mockResolvedValue({ configured: true } as unknown as CloudSyncStatus);
    show();
    // A missing field must not blank the screen or throw inside render.
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  // ─── parked events ────────────────────────────────────────────────────────

  it("shows the parked events while they load, then says plainly when there are none", async () => {
    let resolveList = (value: unknown): void => undefined;
    api.listDeadLetterEvents.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );
    show();

    // The parked list is the only thing still loading: the status resolved immediately.
    await waitFor(() => expect(document.querySelector("[aria-busy='true']")).not.toBeNull());
    resolveList({ accepted: true, entries: [] });
    expect(await screen.findByText("No parked events")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Put Back/ })).toBeNull();
  });

  it("surfaces a refused listing and retries it", async () => {
    api.listDeadLetterEvents.mockResolvedValueOnce({ accepted: false, reason: "Administrator access required" });
    const user = userEvent.setup();
    show();

    expect(await screen.findByText("Administrator access required")).toBeInTheDocument();
    api.listDeadLetterEvents.mockResolvedValue({ accepted: true, entries: [PARKED] });
    await user.click(screen.getAllByRole("button", { name: "Retry" })[0] as HTMLElement);
    expect(await screen.findByText("SK9_BLACK_7/10_000001")).toBeInTheDocument();
  });

  it("lists a parked event by what identifies it and why it stopped, and nothing else", async () => {
    api.listDeadLetterEvents.mockResolvedValue({ accepted: true, entries: [PARKED] });
    show();

    expect(await screen.findByText("SK9_BLACK_7/10_000001")).toBeInTheDocument();
    expect(screen.getByText("QR_MASTER")).toBeInTheDocument();
    expect(screen.getByText("5 refusals")).toBeInTheDocument();
    expect(screen.getByText(/42501/)).toBeInTheDocument();

    // The count column says what it counts. Every row here is already parked, so labelling it
    // "Parked (Dead Letter)" said nothing about the number underneath it.
    expect(screen.getByText("Refusals")).toBeInTheDocument();
    // And that label still belongs to the queue status row, where it means counts.DEAD_LETTER.
    expect(screen.getByText("Parked (Dead Letter)")).toBeInTheDocument();

    // NO PAYLOAD, NO CREDENTIAL. The main process does not hand one over; this proves none of
    // the fields it does hand over leaks something that is not identification.
    const rendered = document.body.textContent ?? "";
    for (const secret of ["password", "token", "anon", "apikey", "payload", "operator"]) {
      expect(rendered.toLowerCase()).not.toContain(secret);
    }
  });

  // ─── putting one back ─────────────────────────────────────────────────────

  it("asks before putting an event back, and explains that it does not send it now", async () => {
    api.listDeadLetterEvents.mockResolvedValue({ accepted: true, entries: [PARKED] });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /Put Back SK9_BLACK_7\/10_000001/ }));

    expect(await screen.findByText("Put this event back in the queue?")).toBeInTheDocument();
    expect(screen.getByText(/does not send it now/)).toBeInTheDocument();
    // The fact names the refusal count, not the queue state the row is already in. Scoped to
    // the dialog: the table behind it carries the same column label.
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Refusals")).toBeInTheDocument();
    // The bare number here: the label already says what it counts. "Refusals / 5 refusals"
    // said it twice.
    expect(dialog.getByText("5")).toBeInTheDocument();
    expect(dialog.queryByText("5 refusals")).toBeNull();
    // The table behind it still spells it out, where the column header means something else.
    expect(screen.getByText("5 refusals")).toBeInTheDocument();
    expect(api.requeueDeadLetterEvent).not.toHaveBeenCalled();
  });

  it("cancelling changes nothing at all", async () => {
    api.listDeadLetterEvents.mockResolvedValue({ accepted: true, entries: [PARKED] });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /Put Back SK9_BLACK/ }));
    await screen.findByText("Put this event back in the queue?");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(api.requeueDeadLetterEvent).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Put this event back in the queue?")).toBeNull());
  });

  it("puts back exactly the event that was chosen, and never another", async () => {
    api.listDeadLetterEvents.mockResolvedValue({ accepted: true, entries: [PARKED, SECOND_PARKED] });
    const user = userEvent.setup();
    show();

    // The SECOND row, to prove the right id travels rather than the first or all of them.
    await user.click(await screen.findByRole("button", { name: /Put Back SK9_BLACK_7\/10_000002/ }));
    await screen.findByText("Put this event back in the queue?");
    await user.click(screen.getByRole("button", { name: "Put Back" }));

    await waitFor(() => expect(api.requeueDeadLetterEvent).toHaveBeenCalledTimes(1));
    expect(api.requeueDeadLetterEvent).toHaveBeenCalledWith("outbox-2");
    // One id per action: there is no bulk recovery to invoke by mistake.
    expect(api.requeueDeadLetterEvent.mock.calls[0]).toHaveLength(1);
    // And the screen is read again afterwards.
    expect(api.getCloudSyncStatus).toHaveBeenCalledTimes(2);
    expect(api.listDeadLetterEvents).toHaveBeenCalledTimes(2);
  });

  it("shows a visible error when the requeue call itself throws, and claims nothing", async () => {
    api.listDeadLetterEvents.mockResolvedValue({ accepted: true, entries: [PARKED] });
    api.requeueDeadLetterEvent.mockRejectedValue(new Error("the main process went away"));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /Put Back SK9_BLACK/ }));
    await screen.findByText("Put this event back in the queue?");
    await user.click(screen.getByRole("button", { name: "Put Back" }));

    // ConfirmDialog awaits onConfirm in a try/finally with no catch, so a rejection would clear
    // the busy flag, show nothing and escape unhandled. The panel turns it into a reason.
    // Regex, because ConfirmDialog renders "⚠ {problem}" as two text nodes.
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
    // Still open, so the operator knows the action did not happen.
    expect(screen.getByText("Put this event back in the queue?")).toBeInTheDocument();
    // Busy cleared: the button is usable again rather than stuck on its working label.
    const confirm = screen.getByRole("button", { name: "Put Back" });
    expect(confirm).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Putting back…" })).toBeNull();
    // Never reported as requeued, and the views were still re-read.
    expect(screen.queryByText(/will go on the next sync/)).toBeNull();
    expect(api.listDeadLetterEvents).toHaveBeenCalledTimes(2);
  });

  it("still shows the requeue error when the refresh that follows it also fails", async () => {
    api.listDeadLetterEvents.mockResolvedValue({ accepted: true, entries: [PARKED] });
    api.requeueDeadLetterEvent.mockRejectedValue(new Error("the main process went away"));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /Put Back SK9_BLACK/ }));
    await screen.findByText("Put this event back in the queue?");

    // Both refreshes fail too. The operator must still read the error about THEIR action.
    api.getCloudSyncStatus.mockRejectedValue(new Error("gone"));
    api.listDeadLetterEvents.mockRejectedValue(new Error("gone"));
    await user.click(screen.getByRole("button", { name: "Put Back" }));

    // Regex, because ConfirmDialog renders "⚠ {problem}" as two text nodes.
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
  });

  it("surfaces a refused requeue and keeps the dialog open", async () => {
    api.listDeadLetterEvents.mockResolvedValue({ accepted: true, entries: [PARKED] });
    api.requeueDeadLetterEvent.mockResolvedValue({
      accepted: false,
      reason: "That event is PENDING, not parked. Only a parked event can be put back.",
    });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /Put Back SK9_BLACK/ }));
    await screen.findByText("Put this event back in the queue?");
    await user.click(screen.getByRole("button", { name: "Put Back" }));

    expect(await screen.findByText(/not parked/)).toBeInTheDocument();
    // Refused, so the list is refreshed and the operator is still looking at the dialog.
    expect(api.listDeadLetterEvents).toHaveBeenCalledTimes(2);
  });
});
