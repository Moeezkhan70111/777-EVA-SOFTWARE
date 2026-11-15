import React from "react";
import { STORE_DIRECTION, type StoreDirection } from "@erp/domain";
import { copy } from "../../../config/copy";
import { HandVoucherPanel } from "../handVoucher/HandVoucherPanel";

/**
 * Manual Entry: material moved without labels, typed in as a numbered store hand voucher rather than scanned —
 * Move In by Hand on Receiving, Move Out by Hand on Issuing.
 */
export const ManualEntry: React.FC<{ direction: StoreDirection; token: string; username?: string }> = ({ direction, token, username }) => (
  <div className="si-manual-open">
    <header className="si-manual-head">
      <h2 className="si-manual-title">{direction === STORE_DIRECTION.OUT ? copy.moveOut.manualTitle : copy.moveOut.manualInTitle}</h2>
    </header>
    <HandVoucherPanel direction={direction} token={token} username={username} />
  </div>
);
