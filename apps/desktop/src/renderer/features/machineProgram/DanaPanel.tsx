import React from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatAmount, packCount, supplierLabel } from "./machineProgram";
import { useDana } from "./useMachineProgramData";

// DANA FOR BLACK — what the store holds to mould a sole in this colour, supplier by supplier.
//
// Information only: a program does not hold Dana, so these are simply the figures in the store.
// Two suppliers' Dana are two cards — never one total — because the bags on the shelf came from
// different places and the operator has to be able to tell them apart.

interface DanaPanelProps {
  colour: string;
}

export const DanaPanel: React.FC<DanaPanelProps> = ({ colour }) => {
  const dana = useDana(colour);
  const cards = dana.value.flatMap((material) =>
    material.sources.map((source) => ({ material, source, key: `${material.itemId}:${source.supplierPartyId ?? ""}` }))
  );

  return (
    <section className="mp-panel" aria-label={copy.machineProgram.danaFor(colour)}>
      <h3 className="mp-panel-title">{copy.machineProgram.danaFor(colour)}</h3>
      {dana.loading && cards.length === 0 ? (
        <StateView kind="loading" compact />
      ) : dana.error ? (
        <StateView kind="error" compact message={dana.error} onRetry={() => void dana.reload()} />
      ) : cards.length === 0 ? (
        <StateView kind="empty" compact title={copy.machineProgram.danaNone(colour)} hint={copy.machineProgram.danaNoneHint} />
      ) : (
        <ul className="mp-stock-cards">
          {cards.map(({ material, source, key }) => (
            <li key={key} className="mp-stock-card">
              <span className="mp-stock-card-supplier">{supplierLabel(source.supplierName)}</span>
              <span className="mp-stock-card-kind">{material.subCategoryName}</span>
              <span className="mp-stock-card-figure">
                {source.packets != null ? `${packCount(source.packets, material.packName)} · ` : ""}
                {formatAmount(source.physical, material.unitCode)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mp-note">{copy.machineProgram.danaInfoOnly}</p>
    </section>
  );
};
