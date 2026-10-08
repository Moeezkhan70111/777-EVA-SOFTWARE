import React, { useEffect, useRef, useState } from "react";

// A small drop-down for the actions that belong on a screen but do not deserve permanent
// space on it. Exporting and importing are done a few times a month; giving each its own
// button would put four of them on a toolbar the operator uses every hour.

export interface ActionMenuItem {
  id: string;
  label: string;
  /** One line under the label, for actions whose consequence is not obvious from the name. */
  hint?: string;
  onSelect: () => void;
  disabled?: boolean;
}

export interface ActionMenuGroup {
  label: string;
  items: ActionMenuItem[];
}

export const ActionMenu: React.FC<{ label: string; groups: ActionMenuGroup[] }> = ({ label, groups }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const usable = groups.filter((group) => group.items.length > 0);
  if (usable.length === 0) return null;

  return (
    <div className="rm-action-menu" ref={wrapRef}>
      <button
        type="button"
        className="btn btn-secondary"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <span className="rm-action-menu-chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="rm-action-menu-panel" role="menu">
          {usable.map((group) => (
            <div key={group.label} className="rm-action-menu-group">
              <span className="rm-action-menu-heading">{group.label}</span>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="rm-action-menu-item"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  <span className="rm-action-menu-label">{item.label}</span>
                  {item.hint ? <span className="rm-action-menu-hint">{item.hint}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
