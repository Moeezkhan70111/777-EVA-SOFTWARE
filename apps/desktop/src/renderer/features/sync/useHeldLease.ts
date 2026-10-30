import { useCallback } from "react";
import type { LeaseDomain } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { usePolledRead, type PolledReply } from "../../hooks/usePolledRead";

// Whether this computer HOLDS a lease domain now: it syncs, the cloud names it the holder, and it
// has caught up (main: leaseGuard.ts heldLeaseDomains). Not "may write" -- a computer without sync
// may write everything and holds nothing.
//
// For screens whose figures are only right where a domain's records are kept. It fails closed:
// until the answer is read, or if it cannot be, the domain is not held, so such a figure stays
// hidden rather than shown wrong. Re-read every 30 seconds, like the write leases.

const REFRESH_MS = 30_000;
const UNREADABLE = "This computer's leases could not be read.";

export interface HeldLease {
  readonly loading: boolean;
  readonly held: boolean;
}

export const useHeldLease = (domain: LeaseDomain): HeldLease => {
  const api = useDesktopApi();
  const read = useCallback(
    async (): Promise<PolledReply<readonly LeaseDomain[]>> => ({ accepted: true, value: await api.getHeldLeases() }),
    [api]
  );
  const polled = usePolledRead(read, { intervalMs: REFRESH_MS, failed: UNREADABLE });
  return { loading: polled.loading, held: polled.value?.includes(domain) ?? false };
};
