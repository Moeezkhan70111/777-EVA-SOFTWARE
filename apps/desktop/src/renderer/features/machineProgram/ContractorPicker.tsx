import React from "react";
import { copy } from "../../config/copy";
import { ChoiceCards } from "./ChoiceCards";
import type { ContractorOption } from "./useMachineProgramData";

// The contractors from the Party Master as cards — the operator picks a name they recognise, in
// one tap. A search box appears once there are enough of them for scanning the list to be work.

const SEARCH_FROM = 8;

interface ContractorPickerProps {
  contractors: ContractorOption[];
  selectedId: string | null;
  onSelect: (contractor: ContractorOption) => void;
}

export const ContractorPicker: React.FC<ContractorPickerProps> = ({ contractors, selectedId, onSelect }) => (
  <ChoiceCards
    size="wide"
    choices={contractors.map((contractor) => ({ key: contractor.id, title: contractor.name, sub: contractor.city || undefined }))}
    selectedKey={selectedId}
    onSelect={(id) => {
      const chosen = contractors.find((contractor) => contractor.id === id);
      if (chosen) onSelect(chosen);
    }}
    searchLabel={copy.machineProgram.contractorSearch}
    searchFrom={SEARCH_FROM}
    noMatch={copy.machineProgram.contractorNoMatch}
    empty={{ title: copy.machineProgram.noContractorsTitle, hint: copy.machineProgram.noContractorsHint }}
  />
);
