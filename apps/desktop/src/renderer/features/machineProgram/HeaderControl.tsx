import React, { useEffect, useRef, useState } from "react";
import { CaretIcon } from "./MachineProgramIcons";

// The labelled controls in the workspace header — the machine, the shift and the date:
//
//   MACHINE                 SHIFT TIME                  PROGRAM DATE
//   ┌──────────────────┐    ┌───────────────────────┐   ┌────────────────────┐
//   │ ▤  Machine 1   ▾ │    │ ◷  06:00 AM – 06:00 PM│▾  │ ▦  Today, 8 Oct  ▾ │
//   └──────────────────┘    └───────────────────────┘   └────────────────────┘
//
// One shell (`HeaderControl`) so all three are the same control, and one list on top of it
// (`HeaderSelect`) for the two that simply choose from a handful of options. The date keeps its
// own picker (ProgramDate) inside the same shell, so changing how the control looks is one
// place (R1).
//
// The list is a real listbox: arrow keys move through it, Enter chooses, Escape closes, and the
// chosen option is announced rather than only drawn in blue (R18).

interface HeaderControlProps {
  label: string;
  icon: React.ReactNode;
  /** What the control currently says. */
  value: string;
  /** The whole control said in one sentence, for a screen reader. */
  ariaLabel: string;
  disabled?: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** The panel under the control while it is open. */
  children?: React.ReactNode;
}

export const HeaderControl: React.FC<HeaderControlProps> = ({
  label,
  icon,
  value,
  ariaLabel,
  disabled = false,
  open,
  onToggle,
  onClose,
  children,
}) => {
  const box = useRef<HTMLDivElement>(null);

  // Clicking anywhere else, or pressing Escape, puts the control away — the same way the
  // operator expects every other dropdown on the floor to behave.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open, onClose]);

  return (
    <div className="mpx-control" ref={box}>
      <span className="mpx-control-label">{label}</span>
      <button
        type="button"
        className="mpx-control-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={onToggle}
      >
        <span className="mpx-control-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="mpx-control-value">{value}</span>
        <CaretIcon className="mpx-control-caret" />
      </button>
      {open && !disabled ? <div className="mpx-popover">{children}</div> : null}
    </div>
  );
};

export interface HeaderOption {
  id: string;
  label: string;
  /** One line under the label — the contractor on a machine, when the shift ends. */
  hint?: string;
}

interface HeaderSelectProps {
  label: string;
  icon: React.ReactNode;
  options: HeaderOption[];
  selectedId: string | null;
  /** What the button says when nothing is chosen yet. */
  placeholder: string;
  disabled?: boolean;
  onChoose: (id: string) => void;
}

export const HeaderSelect: React.FC<HeaderSelectProps> = ({ label, icon, options, selectedId, placeholder, disabled, onChoose }) => {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === selectedId) ?? null;

  const choose = (id: string) => {
    onChoose(id);
    setOpen(false);
  };

  return (
    <HeaderControl
      label={label}
      icon={icon}
      value={selected?.label ?? placeholder}
      ariaLabel={`${label} — ${selected?.label ?? placeholder}`}
      disabled={disabled || options.length === 0}
      open={open}
      onToggle={() => setOpen(!open)}
      onClose={() => setOpen(false)}
    >
      <ul className="mpx-options" role="listbox" aria-label={label}>
        {options.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              role="option"
              aria-selected={option.id === selectedId}
              className={`mpx-option${option.id === selectedId ? " is-selected" : ""}`}
              onClick={() => choose(option.id)}
            >
              <span className="mpx-option-label">{option.label}</span>
              {option.hint ? <span className="mpx-option-hint">{option.hint}</span> : null}
              {option.id === selectedId ? (
                <span className="mpx-option-mark" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </HeaderControl>
  );
};
