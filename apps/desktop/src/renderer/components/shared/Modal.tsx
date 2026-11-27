import React, { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { copy } from "../../config/copy";

// One dialog shell for the whole app. Written for the Raw Material workspace, where the screens
// it replaced repeated the same backdrop / header / actions markup six times and each copy
// handled Escape slightly differently; promoted here when Machine Program needed the same
// dialog, so there is still exactly one of them (R1/R11).
//
// Portalled to <body>: an in-page modal paints underneath the navbar, because .page-content
// creates its own stacking context. So a page's own look (.doc-themed) never reaches it: `themed` puts the dialog
// itself in the card pages' look (title, ×, fields, toggles and buttons from the --sp-* tokens, docs/56), first for the
// Salaries pop-ups (owner, 27 Nov 2026: "the ui ux of pop is not according to theme").

interface ModalProps {
  title: string;
  /** One line under the title — usually which material or machine is being changed. */
  subtitle?: string;
  onClose: () => void;
  /** Rendered on the right of the footer, after Cancel. */
  footer?: React.ReactNode;
  /** Wider shell for content that is a table or a multi-column form; "xl" for side-by-side panels. */
  wide?: boolean | "xl";
  /** Extra class on the dialog, so a page can match its own dialogs (e.g. the narrower product ones). */
  className?: string;
  /** A control at the top right, beside ×: a way out to a related page (the contractors dialog's "+ Add Party"). */
  headerAction?: React.ReactNode;
  /** The dialog in the card pages' look (.doc-themed). */
  themed?: boolean;
  /** The footer's way out, when Cancel is not the word: "Close" on a card that only shows, "Back" from a step. */
  dismissLabel?: string;
  /** What that button does, when it is not closing the dialog (going back a step). × and Escape still close it. */
  onDismiss?: () => void;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({ title, subtitle, onClose, footer, wide = false, className, headerAction, themed = false, dismissLabel, onDismiss, children }) => {
  const titleId = useId();
  const widthClass = (wide === "xl" ? " rm-modal--xl" : wide ? " rm-modal--wide" : "") + (themed ? " doc-themed" : "") + (className ? ` ${className}` : "");

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [onClose]);

  return createPortal(
    <div
      className="member-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`member-modal rm-modal${widthClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="member-modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p className="rm-modal-sub">{subtitle}</p> : null}
          </div>
          <div className="member-modal-header-actions">
            {headerAction}
            <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        <div className="rm-modal-body">{children}</div>

        <div className="member-modal-actions">
          <span />
          <button type="button" className="btn btn-secondary" onClick={onDismiss ?? onClose}>
            {dismissLabel ?? copy.common.cancel}
          </button>
          {footer}
        </div>
      </section>
    </div>,
    document.body
  );
};
