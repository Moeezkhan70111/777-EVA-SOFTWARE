import React from "react";
import type { LeaseDomain } from "@erp/domain";
import { ReadOnlyNotice } from "../../components/shared/ReadOnlyNotice";
import { StateView } from "../../components/shared/StateView";
import type { WriteLeaseStatus } from "../../types/desktopApi";
import { useWriteLease } from "../sync/useWriteLease";

// A station that WRITES a leased domain, shown only where this computer may write it
// (docs/37 section W). On a reader it is replaced by the read-only notice and, when given, a
// reader's station instead (ReaderStation, for the store's scan stations), which shows the notice itself.
//
// The station itself is unchanged: this decides whether it is shown, nothing else. The main process
// refuses the write regardless (leaseGuard.ts).

interface LeasedStationProps {
  domain: LeaseDomain;
  /** What a reader gets instead, given the status to explain. Left out, the notice alone. */
  reader?: (status: WriteLeaseStatus | null) => React.ReactNode;
  children: React.ReactNode;
}

export const LeasedStation: React.FC<LeasedStationProps> = ({ domain, reader, children }) => {
  const lease = useWriteLease(domain);
  if (lease.loading) return <StateView kind="loading" compact />;
  if (lease.canWrite) return <>{children}</>;
  return reader === undefined ? <ReadOnlyNotice status={lease.status} /> : <>{reader(lease.status)}</>;
};
