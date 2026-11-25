import { LEASE_DOMAIN, PERMISSION } from "@erp/domain";
import { useOptionalSession } from "../auth/SessionContext";
import { useWriteLease } from "../sync/useWriteLease";

// WHO MAY ADD A PARTY from a page other than Party Master (owner, 25 Nov 2026: "+ New contractor" in the contractors
// dialog). The main process's own rule (ipc/parties.ts createParty): the Party Form permission, on the computer that
// writes parties (the PARTIES lease, leaseChannels.ts). The screen only decides what to offer.

export const useCanCreateParty = (): boolean => {
  const session = useOptionalSession();
  const parties = useWriteLease(LEASE_DOMAIN.PARTIES);
  return (session?.can(PERMISSION.PARTY_FORM) ?? false) && parties.canWrite;
};
