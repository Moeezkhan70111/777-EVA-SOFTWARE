import { LEASE_DOMAIN } from "@erp/domain";
import { useOptionalSession } from "../features/auth/SessionContext";
import { useWriteLease } from "../features/sync/useWriteLease";

// WHO MAY ADD A COLOUR TO AN ARTICLE: one rule for every page that takes quantities by colour (owner, 25 Nov 2026:
// "every page has its own rule ... make one"). Enter Orders, Gatepass, Opening Stock and Stock Adjustment, Manual
// Production and its Edit all ask here, and all offer the same two controls when it says yes: "+ New colour" beside the
// article (AddColorControl) and "+ Add" in a size the colour is not made in (MissingSizeCell), both through the one
// call addArticleColor (components/shared/articleColor.ts).
//
// The rule is the main process's own (ipc/cartonStockAdjustments.ts addArticleColor): AN ADMINISTRATOR, ON THE COMPUTER
// THAT WRITES PRODUCT MASTER (the MASTER_DATA lease). The screens only decide what to offer; the main process refuses
// the write to anyone else, anywhere else.

export const canAddColour = (input: { isAdmin: boolean; writesProductMaster: boolean }): boolean => input.isAdmin && input.writesProductMaster;

export const useCanAddColour = (): boolean => {
  const session = useOptionalSession();
  const productMaster = useWriteLease(LEASE_DOMAIN.MASTER_DATA);
  return canAddColour({ isAdmin: session?.isAdmin ?? false, writesProductMaster: productMaster.canWrite });
};
