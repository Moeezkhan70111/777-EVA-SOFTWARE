import React from "react";
import { copy } from "../../config/copy";

// The one presentation of the three non-success states every async screen must show
// (CLAUDE.md R12). Pages render <StateView> instead of writing their own "Loading…" /
// "No records" / error markup, so the wording, spacing and retry affordance stay identical.

interface StateViewBaseProps {
  /** Compact variant for panels inside a page rather than a whole page. */
  compact?: boolean;
}

export interface LoadingStateProps extends StateViewBaseProps {
  kind: "loading";
  message?: string;
}

export interface EmptyStateProps extends StateViewBaseProps {
  kind: "empty";
  title?: string;
  /** What the operator can do next, e.g. "Start production by scanning a QR code." */
  hint?: string;
  action?: { label: string; onClick: () => void };
}

export interface ErrorStateProps extends StateViewBaseProps {
  kind: "error";
  title?: string;
  /** Operational message; never a raw stack trace. */
  message?: string;
  onRetry?: () => void;
}

export type StateViewProps = LoadingStateProps | EmptyStateProps | ErrorStateProps;

export const StateView = (props: StateViewProps) => {
  const className = `state-view state-view--${props.kind}${props.compact ? " state-view--compact" : ""}`;

  if (props.kind === "loading") {
    return (
      <div className={className} role="status" aria-live="polite" aria-busy="true">
        <span className="state-view-spinner" aria-hidden="true" />
        <span className="state-view-title">{props.message ?? copy.common.loading}</span>
      </div>
    );
  }

  if (props.kind === "empty") {
    return (
      <div className={className} role="status">
        <span className="state-view-title">{props.title ?? copy.states.emptyTitle}</span>
        {props.hint && <span className="state-view-hint">{props.hint}</span>}
        {props.action && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={props.action.onClick}>
            {props.action.label}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={className} role="alert">
      <span className="state-view-title">⚠ {props.title ?? copy.states.loadFailedTitle}</span>
      <span className="state-view-hint">{props.message ?? copy.states.loadFailedBody}</span>
      {props.onRetry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={props.onRetry}>
          {copy.common.retry}
        </button>
      )}
    </div>
  );
};
