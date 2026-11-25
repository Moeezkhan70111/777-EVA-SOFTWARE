import React, { useMemo } from "react";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { copy } from "../../config/copy";
import type { ContractorOption } from "./useCartonProgram";

// ONE OF A MACHINE'S TWO CONTRACTORS in its dialog (owner, 25 Nov 2026, the UI/UX pass): the same searchable panel
// picker as every party picker (Jakob), and the contractor it had before said under it once changed ("was ALAMGIR":
// recognition over recall). A contractor not on the list yet is added in Party Master, from the dialog's "+ Add Party".

const text = copy.cartonProgram;

interface ContractorFieldProps {
  label: string;
  contractors: readonly ContractorOption[];
  value: string;
  /** The contractor saved on the machine now; null when adding a machine. */
  current: string | null;
  onChange: (partyId: string) => void;
}

export const ContractorField: React.FC<ContractorFieldProps> = ({ label, contractors, value, current, onChange }) => {
  const options = useMemo(
    () => contractors.map((contractor) => ({ value: contractor.id, label: contractor.name, detail: contractor.city || undefined })),
    [contractors]
  );
  const before = current && value !== current ? contractors.find((contractor) => contractor.id === current)?.name : undefined;
  return (
    <div className="form-group mp-contractor-field">
      <span className="input-label">{label}</span>
      <SearchableCombobox value={value} options={options} placeholder={text.chooseContractor} searchPlaceholder={text.contractorSearch}
        emptyLabel={text.noContractorMatch} ariaLabel={label} onChange={onChange} />
      {before ? <span className="mp-contractor-was">{text.wasContractor(before)}</span> : null}
    </div>
  );
};
