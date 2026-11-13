import React from "react";

export interface KpiCardProps {
  label: string;
  value: string | number;
  tone?: "default" | "accent" | "ok" | "warn";
  sub?: string;
  /** A page's own look on top of the card's (e.g. Carton Stock's cs-summary). */
  className?: string;
}

export const KpiCard = ({ label, value, tone = "default", sub, className }: KpiCardProps) => (
  <div className={["kpi-card", tone !== "default" ? tone : "", className ?? ""].filter(Boolean).join(" ")}>
    <div className="kpi-label">{label}</div>
    <div className="kpi-value">{value}</div>
    {sub ? <div className="text-muted text-small">{sub}</div> : null}
  </div>
);
