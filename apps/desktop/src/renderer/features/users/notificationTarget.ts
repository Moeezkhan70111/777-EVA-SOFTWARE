import { NOTIFICATION_KIND } from "@erp/domain";
import type { UserNotification } from "./types";

// Where a typed notification takes the user when clicked.
//
// A gatepass notice — new, or cancelled — opens the Sale Voucher screen for that gatepass:
// it pre-fills a new bill, or opens the bill already made from it (with the cancellation
// warning when there is one).
//
// A stock-correction notice opens the raw material it is about, with its drawer already
// open: that is where the administrator can see the current count and the movement history
// before approving, and where the requester can see what happened.
//
// A machine-program notice opens that program on Store Out, where the storekeeper issues its
// uppers against it.

export type NotificationTarget =
  | { route: "sale-voucher-form"; gatepassId: string }
  | { route: "gatepass-list"; gatepassId: string }
  | { route: "raw-material"; itemId: string }
  | { route: "store-out-operator"; programId: string };

const STOCK_CORRECTION_KINDS: ReadonlySet<string> = new Set([
  NOTIFICATION_KIND.STOCK_CORRECTION_REQUESTED,
  NOTIFICATION_KIND.STOCK_CORRECTION_APPROVED,
  NOTIFICATION_KIND.STOCK_CORRECTION_REJECTED,
]);

export const notificationTarget = (notification: Pick<UserNotification, "kind" | "entityId">): NotificationTarget | null => {
  const entityId = notification.entityId?.trim();
  if (!entityId) return null;
  // The billing desk is sent to the bill it has to make; every other stage is sent to the
  // Gatepass itself, where its journey and what it is waiting on are both on one screen.
  if (notification.kind === NOTIFICATION_KIND.GATEPASS_CREATED || notification.kind === NOTIFICATION_KIND.GATEPASS_CANCELLED) {
    return { route: "sale-voucher-form", gatepassId: entityId };
  }
  if (
    notification.kind === NOTIFICATION_KIND.GATEPASS_BILLED ||
    notification.kind === NOTIFICATION_KIND.GATEPASS_AT_GATE ||
    notification.kind === NOTIFICATION_KIND.GATEPASS_DISPATCHED
  ) {
    return { route: "gatepass-list", gatepassId: entityId };
  }
  if (notification.kind && STOCK_CORRECTION_KINDS.has(notification.kind)) {
    return { route: "raw-material", itemId: entityId };
  }
  // A machine program notice opens that program on STORE OUT, which is where its uppers are
  // fetched — not on the Machine Program screen, which is where Production plans them. The id
  // travels, never the printed number: the number is a label, the id is the record.
  // A reconciliation notice opens the same program, where its reconciliation is shown line by line.
  if (notification.kind === NOTIFICATION_KIND.MACHINE_PROGRAM_ISSUED || notification.kind === NOTIFICATION_KIND.MACHINE_PROGRAM_RECONCILED) {
    return { route: "store-out-operator", programId: entityId };
  }
  return null;
};
