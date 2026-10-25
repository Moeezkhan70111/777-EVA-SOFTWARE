import { useEffect, useState } from "react";
import type { LeaseDomain } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { WriteLeaseStatus } from "../../types/desktopApi";

// Whether this computer may write the leased domains now (docs/37 section W).
//
// The screens use it to show a domain read-only on a reader. It authorises nothing: the main process
// refuses the write itself (leaseGuard.ts), whatever the screen shows. So when the answer cannot be
// read at all, nothing is hidden -- the gate still decides, and says why.
//
// Re-read every 30 seconds, so a lease granted or taken over shows up without leaving the screen.

const REFRESH_MS = 30_000;

export interface WriteLeases {
  /** Still asking. */
  readonly loading: boolean;
  /** Null when the answer could not be read. */
  readonly statuses: readonly WriteLeaseStatus[] | null;
}

export const useWriteLeases = (): WriteLeases => {
  const api = useDesktopApi();
  const [statuses, setStatuses] = useState<readonly WriteLeaseStatus[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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
  }, [api]);

  return { loading, statuses };
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
