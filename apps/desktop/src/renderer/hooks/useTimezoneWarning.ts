import { useEffect, useRef } from "react";
import { APP_TIMEZONE } from "@erp/domain";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";

// SAID AT SIGN-IN, ON A COMPUTER SET TO THE WRONG TIME ZONE.
//
// The time zone is a Windows setting the application cannot change, and a machine arrives set to
// whatever the shop left it on. Business dates are worked out in Pakistan time whatever the machine
// says, but anything read from the machine's own clock is not, so a wrong zone is a silent trap.
//
// Raised once per session and kept until dismissed (ttl 0), like the number range: it is a setup
// task, and a notice that expires after four seconds on a factory PC is a notice nobody saw.

/** The zone Windows is set to, as the browser names it. Pakistan Standard Time reads Asia/Karachi. */
export const machineTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Warns, once per person signing in, when this computer is not on the business time zone. */
export const useTimezoneWarning = (userId: string | null, readZone: () => string = machineTimezone): void => {
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

    const zone = readZone();
    if (zone !== APP_TIMEZONE) push("warning", copy.timezone.wrongTitle, copy.timezone.wrongBody(zone), 0);
  }, [userId, push, readZone]);
};
