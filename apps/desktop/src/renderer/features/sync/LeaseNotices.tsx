import React from "react";
import type { LeaseDomain } from "@erp/domain";
import { ReadOnlyNotice } from "../../components/shared/ReadOnlyNotice";
import { useWriteLeases } from "./useWriteLease";

// The read-only notices for a screen that writes one or more leased domains (docs/37 section W):
// one per domain this computer may not write, nothing at all where it may write them all.

export const LeaseNotices: React.FC<{ domains: readonly LeaseDomain[] }> = ({ domains }) => {
  const { statuses } = useWriteLeases();
  if (statuses === null) return null;
  return (
    <>
      {statuses
        .filter((status) => domains.includes(status.domain))
        .map((status) => (
          <ReadOnlyNotice key={status.domain} status={status} />
        ))}
    </>
  );
};
