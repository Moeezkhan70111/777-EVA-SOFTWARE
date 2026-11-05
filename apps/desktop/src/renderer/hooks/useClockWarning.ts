import { useEffect, useRef } from "react";
import { useDesktopApi } from "./useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";

// SAID WHEN THIS COMPUTER'S CLOCK IS WRONG.
//
// The clock is read against the cloud's replies during a sync pass, so unlike the time zone it is
// not known at sign-in: the first pass may come a minute later. This asks until it has an answer
// worth saying, then stops. Whether a clock is wrong is decided in @erp/sync; this only says so.
//
// A computer that has not reached the cloud has no reading and says nothing. Raised once per
// session and kept until dismissed (ttl 0), like the time zone: it is a setup task, and every time
// this computer records is wrong until it is done.

const POLL_INTERVAL_MS = 60_000;

/** Warns, once per person signing in, when the cloud says this computer's clock is wrong. */
export const useClockWarning = (userId: string | null): void => {
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

    let stopped = false;
    let timer: number | undefined;
    const stop = () => {
      stopped = true;
      window.clearInterval(timer);
    };
    const check = async () => {
      try {
        const skew = (await api.getCloudSyncStatus()).clockSkew;
        if (stopped || !skew) return;
        warnedFor.current = userId;
        stop();
        push("warning", copy.clock.wrongTitle, copy.clock.wrongBody(skew), 0);
      } catch {
        // No session or no bridge yet: both announce themselves elsewhere, and the next look retries.
      }
    };

    timer = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    void check();
    return stop;
  }, [userId, api, push]);
};
