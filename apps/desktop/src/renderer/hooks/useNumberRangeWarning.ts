import { useEffect, useRef } from "react";
import { useDesktopApi } from "./useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";

// SAID AT SIGN-IN, NOT AT THE PRINTER.
//
// A computer with no number range cannot create a numbered document and — since the serial block
// scheme — cannot print QR labels either. Both refuse clearly when tried, but by then somebody
// has walked to the label printer with a run to produce, or filled in a gatepass.
//
// So it is said once, plainly, when the first person signs in. A newly provisioned computer
// announces what it is missing before anybody relies on it.
//
// Raised once per session and kept until dismissed (ttl 0): it is a provisioning task for an
// administrator, not a transient event, and a notice that expires after four seconds on a
// factory PC is a notice nobody saw. The notice's own ✕ is the way to clear it, so no action
// button is added — a second "Close" beside it would be noise.

/**
 * Warns, once, when this computer has no usable number range.
 *
 * Takes the signed-in user id rather than reading the session itself: `getNumberBlockStatus`
 * requires a session, and this must run after sign-in, not before it. A changed user re-checks,
 * which costs one read and covers the case where provisioning happened mid-session.
 */
export const useNumberRangeWarning = (userId: string | null): void => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  // So a re-render cannot re-raise a notice the operator has just dismissed.
  const warnedFor = useRef<string | null>(null);

  useEffect(() => {
    if (userId === null) {
      warnedFor.current = null;
      return;
    }
    if (warnedFor.current === userId) return;
    warnedFor.current = userId;

    void (async () => {
      try {
        const status = await api.getNumberBlockStatus();
        // A usable range is the normal case and says nothing at all.
        if (!status || status.problem === null || status.problem === undefined) return;

        const invalid = status.problem === "INVALID";
        push(
          "warning",
          invalid ? copy.numberRange.invalidTitle : copy.numberRange.missingTitle,
          invalid ? copy.numberRange.invalidBody(String(status.storedValue ?? "")) : copy.numberRange.missingBody,
          0
        );
      } catch {
        // A computer that cannot even be asked is not a computer to raise a numbering warning
        // on — the session or the bridge is the problem, and both announce themselves elsewhere.
      }
    })();
  }, [userId, api, push]);
};
