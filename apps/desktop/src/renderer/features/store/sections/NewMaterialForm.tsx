import React from "react";
import { copy } from "../../../config/copy";
import { StateView } from "../../../components/shared/StateView";
import { NewMaterialModal } from "../../rawMaterial/NewMaterialModal";
import type { useRawMaterialLookups } from "../../rawMaterial/useRawMaterialLookups";

/** Step 1 of receiving: the material has to exist before a label can name it. */
export const NewMaterialForm: React.FC<{
  lookups: ReturnType<typeof useRawMaterialLookups>;
  formKey: number;
  onDone: () => void;
}> = ({ lookups, formKey, onDone }) => {
  // Loading shows only on first arrival: a reload after adding a unit or an option mid-form
  // must not unmount the form and throw away what was typed.
  if (lookups.loading && lookups.categories.length === 0) return <StateView kind="loading" message={copy.common.loading} />;
  if (lookups.error) return <StateView kind="error" message={lookups.error} onRetry={() => void lookups.reload()} />;
  return (
    <NewMaterialModal
      key={formKey}
      layout="page"
      categories={lookups.categories}
      units={lookups.units}
      onClose={onDone}
      onCreated={lookups.reload}
      onLookupsChanged={lookups.reload}
    />
  );
};
