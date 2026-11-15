import React from "react";
import { STORE_HAND_VOUCHER_STATUS } from "@erp/domain";
import { copy } from "../../../config/copy";
import type { HandVoucher } from "../../../types/desktopApi";
import { formatDateTime } from "../../../utils/dates";
import { formatQuantity } from "../../rawMaterial/rawMaterial";

// A stored store hand voucher (Move In or Move Out), read-only:
//
//   SIV-100012  ✓ Posted                       [ Print slip ] [ Edit ] [ Delete ]
//   SHEHZAD RUBBER · 15 Nov 2026 · 6:47 PM · Written by aslam
//   #  Material               Quantity    In stock
//   1  NAWAAR 5 SOOTAR BLACK  3 RULE      2,925 INCH
//
// Edit and Delete are offered only while it is today's and posted; the data layer decides that again.

interface VoucherDetailsProps {
  voucher: HandVoucher;
  busy: boolean;
  onPrint: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

const StatusBadge: React.FC<{ voucher: HandVoucher }> = ({ voucher }) =>
  voucher.status === STORE_HAND_VOUCHER_STATUS.DELETED ? (
    <span className="badge badge-err">✕ {copy.handVoucher.statusDeleted}</span>
  ) : (
    <span className="badge badge-ok">✓ {copy.handVoucher.statusPosted}</span>
  );

/** Who wrote it, who last changed it, who deleted it. */
const whoLine = (voucher: HandVoucher): string => {
  const words = copy.handVoucher;
  const parts = [words.writtenBy(voucher.createdBy)];
  if (voucher.revision > 1 && voucher.updatedBy && voucher.status !== STORE_HAND_VOUCHER_STATUS.DELETED) parts.push(words.editedBy(voucher.updatedBy));
  if (voucher.deletedBy) parts.push(words.deletedBy(voucher.deletedBy));
  return parts.join(" · ");
};

export const VoucherDetails: React.FC<VoucherDetailsProps> = ({ voucher, busy, onPrint, onEdit, onDelete }) => {
  const words = copy.handVoucher;
  const deleted = voucher.status === STORE_HAND_VOUCHER_STATUS.DELETED;

  return (
    <section className="siv-details" aria-label={voucher.code}>
      <header className="siv-details-head">
        <div className="siv-details-title">
          <h3 className="siv-code">{voucher.code}</h3>
          <StatusBadge voucher={voucher} />
        </div>
        <div className="siv-actions">
          <button type="button" className="btn btn-secondary" disabled={busy || deleted} onClick={onPrint}>
            {words.print}
          </button>
          {voucher.editable ? (
            <>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={onEdit}>
                {words.edit}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={onDelete}>
                {words.delete}
              </button>
            </>
          ) : null}
        </div>
      </header>

      <p className="siv-meta">
        <b>{voucher.partyName}</b> · {formatDateTime(voucher.createdAt)} · {whoLine(voucher)}
      </p>
      {voucher.note ? (
        <p className="siv-meta">
          {words[voucher.direction].note}: {voucher.note}
        </p>
      ) : null}

      <div className="siv-table-wrap">
        <table className="data-table siv-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{words.material}</th>
              <th scope="col" className="num">{words.quantity}</th>
              <th scope="col" className="num">{words.stockUnitNote}</th>
            </tr>
          </thead>
          <tbody>
            {voucher.lines.map((line) => (
              <tr key={line.lineNo}>
                <td>{line.lineNo}</td>
                <td>{line.itemName}</td>
                <td className="num">
                  {formatQuantity(line.typedQuantity)} {line.typedUnitCode}
                </td>
                <td className="num">
                  {formatQuantity(line.quantity)} {line.stockUnitCode}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deleted ? <p className="field-help">{words[voucher.direction].deletedNote}</p> : null}
      {!deleted && !voucher.editable ? <p className="field-help">{words.lockedNote}</p> : null}
    </section>
  );
};
