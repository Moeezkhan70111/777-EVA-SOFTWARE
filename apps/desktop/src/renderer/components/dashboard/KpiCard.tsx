import React from "react";

export interface KpiCardProps {
  label: string;
  value: string | number;
  tone?: "default" | "accent" | "ok" | "warn";
  sub?: string;
}

export const KpiCard = ({ label, value, tone = "default", sub }: KpiCardProps) => (
  <div className={`kpi-card${tone !== "default" ? ` ${tone}` : ""}`}>
    <div className="kpi-label">{label}</div>
    <div className="kpi-value">{value}</div>
    {sub ? <div className="text-muted text-small">{sub}</div> : null}
  </div>
);
