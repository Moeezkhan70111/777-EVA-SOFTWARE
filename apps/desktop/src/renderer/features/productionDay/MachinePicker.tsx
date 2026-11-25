import React, { useRef } from "react";
import type { ProductionDayView } from "@erp/domain";
import { copy } from "../../config/copy";
import { dozenFigure } from "../cartonStock/CartonMatrix";
import { shareOf } from "./dayInsights";

// WHICH MACHINE'S PRODUCTION (owner, 15–16 Nov 2026): one card per machine beside the day's total, in place of the
// Cartons / Machines / Entries cards. Styled like the Store page's In / Out buttons: white cards with an icon tile
// that lift on hover, the chosen one in the same blue gradient with a ✓. All the same size.
//
//   [ TOTAL 15.5 DOZEN ]  [▦ All machines ✓]  [⚙ MACHINE 1]  [⚙ MACHINE 2]   each with its dozens underneath
//
// Tabs for a screen reader (the panel below is labelled by the chosen one); ← and → move between them.
//
// Each machine says its share of the day (owner, 25 Nov 2026): a thin bar and the percent in words, so the busiest
// machine is seen at a glance and never by the bar alone.

const text = copy.productionDay;
export const ALL_MACHINES = "all";

interface MachinePickerProps {
  day: ProductionDayView;
  active: string;
  onSelect: (id: string) => void;
}

/** Every machine together: four squares. */
const AllIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="11" y="3" width="6" height="6" rx="1.5" />
    <rect x="3" y="11" width="6" height="6" rx="1.5" /><rect x="11" y="11" width="6" height="6" rx="1.5" />
  </svg>
);

/** One machine: a press with its dial. */
const MachineIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <rect x="3" y="5" width="14" height="10" rx="2" /><circle cx="8" cy="10" r="2.2" /><path d="M12.5 8.5h2M12.5 11.5h2M6 15v2M14 15v2" />
  </svg>
);

const choicesOf = (day: ProductionDayView) => [
  { id: ALL_MACHINES, name: text.allMachines, cartons: day.totalCartons },
  ...day.machines.map((machine) => ({ id: machine.machineName, name: machine.machineName, cartons: machine.cartons })),
];

export const MachinePicker: React.FC<MachinePickerProps> = ({ day, active, onSelect }) => {
  const choices = choicesOf(day);
  const listRef = useRef<HTMLDivElement>(null);

  const moveBy = (step: number) => {
    const index = choices.findIndex((choice) => choice.id === active);
    const next = choices[(index + step + choices.length) % choices.length];
    onSelect(next.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-machine="${CSS.escape(next.id)}"]`)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowRight") moveBy(1);
    else if (event.key === "ArrowLeft") moveBy(-1);
    else return;
    event.preventDefault();
  };

  return (
    <div ref={listRef} className="pd-machines" role="tablist" aria-label={text.viewsLabel} onKeyDown={onKeyDown}>
      {choices.map((choice) => {
        const selected = choice.id === active;
        return (
          <button key={choice.id} type="button" role="tab" id={`tab-${choice.id}`} data-machine={choice.id}
            aria-selected={selected} tabIndex={selected ? 0 : -1}
            className={`pd-machine${selected ? " is-selected" : ""}`} onClick={() => onSelect(choice.id)}>
            <span className="pd-machine-icon">{choice.id === ALL_MACHINES ? <AllIcon /> : <MachineIcon />}</span>
            <span className="pd-machine-text">
              <span className="pd-machine-name">{choice.name}</span>
              <span className="pd-machine-dozens">{text.machineDozens(dozenFigure(choice.cartons))}</span>
              {choice.id === ALL_MACHINES ? null : (
                <span className="pd-machine-share">
                  <span className="pd-machine-share-track" aria-hidden="true"><span style={{ inlineSize: `${String(shareOf(choice.cartons, day.totalCartons))}%` }} /></span>
                  <span className="pd-machine-share-text">{text.shareOfDay(shareOf(choice.cartons, day.totalCartons))}</span>
                </span>
              )}
            </span>
            {selected ? <span className="pd-machine-mark" aria-hidden="true">✓</span> : null}
          </button>
        );
      })}
    </div>
  );
};
