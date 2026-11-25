import { LEASE_DOMAIN, PERMISSION } from "@erp/domain";
import { useOptionalSession } from "../auth/SessionContext";
import { useWriteLease } from "../sync/useWriteLease";

// WHO MAY CHANGE A MACHINE'S CONTRACTORS, wherever a machine is shown with its contractors (Machine Program, and the
// machine cards on Manual Production, owner, 25 Nov 2026). The main process's own rule (ipc/machinePrograms.ts
// assignMachineContractor): the Machine Program permission, on the computer that writes Product Master (MASTER_DATA,
// leaseChannels.ts). The screen only decides what to offer; the main process refuses it to anyone else, anywhere else.

export const useCanChangeContractors = (): boolean => {
  const session = useOptionalSession();
  const productMaster = useWriteLease(LEASE_DOMAIN.MASTER_DATA);
  return (session?.can(PERMISSION.MACHINE_PROGRAM) ?? false) && productMaster.canWrite;
};
