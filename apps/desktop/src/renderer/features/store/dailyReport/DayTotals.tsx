import React from "react";
import type { StoreDayCartonTotal, StoreDayMaterialTotal } from "@erp/domain";
import { copy } from "../../../config/copy";
import { quantityText } from "./storeDailyReportView";

// What moved, added up: raw material per material, and cartons per article, size and colour.
// Each table is shown only when the day has something of its kind.

const text = copy.storeDailyReport;

export const MaterialTotals: React.FC<{ rows: StoreDayMaterialTotal[] }> = ({ rows }) => (
  <section className="sdr-section" aria-label={text.materialsTitle}>
    <h3 className="sdr-section-title">{text.materialsTitle}</h3>
    <div className="table-wrap sdr-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{text.material}</th>
            <th scope="col" className="sdr-num">{text.packets}</th>
            <th scope="col" className="sdr-num">{text.typed}</th>
            <th scope="col" className="sdr-num">{text.quantity}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.itemId}|${row.unitCode}`}>
              <td>{row.itemDisplayName}</td>
              <td className="sdr-num">{row.packets || "—"}</td>
              <td className="sdr-num">{row.typed || "—"}</td>
              <td className="sdr-num sdr-strong">{quantityText(row.quantity, row.unitCode)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);

export const CartonTotals: React.FC<{ rows: StoreDayCartonTotal[] }> = ({ rows }) => (
  <section className="sdr-section" aria-label={text.cartonsTitle}>
    <h3 className="sdr-section-title">{text.cartonsTitle}</h3>
    <div className="table-wrap sdr-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{text.article}</th>
            <th scope="col">{text.size}</th>
            <th scope="col">{text.colour}</th>
            <th scope="col" className="sdr-num">{text.cartons}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.article}|${row.size}|${row.color}`}>
              <td>{row.article}</td>
              <td>{row.size}</td>
              <td>{row.color}</td>
              <td className="sdr-num sdr-strong">{row.cartons.toLocaleString("en-US")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);
