import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { LeaseDomain } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { WriteLeaseStatus } from "../../types/desktopApi";

// Whether this computer may write the leased domains now (docs/37 section W).
//
// The screens use it to show a domain read-only on a reader. It authorises nothing: the main process
// refuses the write itself (leaseGuard.ts), whatever the screen shows. So when the answer cannot be
// read at all, nothing is hidden -- the gate still decides, and says why.
//
// ONE ANSWER FOR THE WHOLE APP. WriteLeasesProvider asks once when the app starts and re-reads every
// 30 seconds, so a lease granted or taken over shows up without leaving the screen. A pane opened
// later reads the answer already held: it is not "read only" for a moment while it asks again.
// Outside the provider (a screen rendered on its own, as in a test) the hook asks for itself.

const REFRESH_MS = 30_000;

export interface WriteLeases {
  /** Still asking. */
  readonly loading: boolean;
  /** Null when the answer could not be read. */
  readonly statuses: readonly WriteLeaseStatus[] | null;
}

/** Asks, and keeps asking every REFRESH_MS, while `enabled`. */
const usePolledWriteLeases = (enabled: boolean): WriteLeases => {
  const api = useDesktopApi();
  const [statuses, setStatuses] = useState<readonly WriteLeaseStatus[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const read = async () => {
      try {
        const all = await api.getWriteLeases();
        if (alive) setStatuses(all);
      } catch {
        if (alive) setStatuses(null);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, enabled]);

  // The same object until the answer changes, so the provider does not redraw every screen with it.
  return useMemo(() => ({ loading, statuses }), [loading, statuses]);
};

const WriteLeasesContext = createContext<WriteLeases | null>(null);

/** Holds the one answer every screen reads. Mounted once, around the app. */
export const WriteLeasesProvider = ({ children }: { children: React.ReactNode }) => {
  const leases = usePolledWriteLeases(true);
  return <WriteLeasesContext.Provider value={leases}>{children}</WriteLeasesContext.Provider>;
};

export const useWriteLeases = (): WriteLeases => {
  const shared = useContext(WriteLeasesContext);
  const own = usePolledWriteLeases(shared === null);
  return shared ?? own;
};

export interface WriteLease {
  /** Still asking. Read as "not writable", so a reader never sees a station for a moment. */
  readonly loading: boolean;
  readonly canWrite: boolean;
  /** Null when the answer could not be read. */
  readonly status: WriteLeaseStatus | null;
}

/** One domain. A domain this version does not enforce is writable here. */
export const useWriteLease = (domain: LeaseDomain): WriteLease => {
  const { loading, statuses } = useWriteLeases();
  const status =
    statuses === null ? null : (statuses.find((entry) => entry.domain === domain) ?? { domain, canWrite: true, reason: null, holderLabel: null });
  return { loading, canWrite: !loading && (status?.canWrite ?? true), status };
};
