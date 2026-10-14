import React from "react";
import { CLAIM_PARTY_ROLE, fromPaisa, type ClaimPartyRole } from "@erp/domain";
import { copy } from "../../../config/copy";
import { formatMoney } from "../../../app/format";
import type { ReconciliationLine, ReconciliationParty } from "../../../types/desktopApi";
import { claimTotalPaisa, cleanCount, cleanRupees, newClaim, ratePaisaOf, type ClaimDraft } from "./upperDraft";

// DAMAGED / CLAIM — pairs claimed against whoever is answerable, at an amount a pair.
//
//   Against [ Supplier — ABC UPPER ▾ ]  Pairs [ 1 ]  Amount per pair (Rs) [ 50 ]  Total Rs 50.00
//   Reason  [ torn upper                                        ]                        [ × ]
//   + Add claim
//
// The total is shown before anything is saved; it is deducted on that party's ledger when the
// program closes. Each claim's fields stay together, and adding one never clears another.

const text = copy.programClose;

interface Parties {
  machine: ReconciliationParty | null;
  packing: ReconciliationParty | null;
}

/** Who a claim can be against: each supplier of the upper, and the program's two contractors. */
const options = (line: ReconciliationLine, parties: Parties) => [
  ...line.suppliers.map((supplier) => ({ value: `${CLAIM_PARTY_ROLE.SUPPLIER}:${supplier.partyId}`, label: text.claimSupplier(supplier.name), disabled: false })),
  { value: CLAIM_PARTY_ROLE.MACHINE, label: parties.machine ? text.machineContractor(parties.machine.name) : text.noContractor, disabled: !parties.machine },
  { value: CLAIM_PARTY_ROLE.PACKING, label: parties.packing ? text.packingContractor(parties.packing.name) : text.noContractor, disabled: !parties.packing },
];

const valueOf = (claim: ClaimDraft): string =>
  claim.role === CLAIM_PARTY_ROLE.SUPPLIER ? (claim.supplierPartyId ? `${CLAIM_PARTY_ROLE.SUPPLIER}:${claim.supplierPartyId}` : "") : claim.role;

const ROLES: readonly ClaimPartyRole[] = Object.values(CLAIM_PARTY_ROLE);

const chosen = (value: string): Pick<ClaimDraft, "role" | "supplierPartyId"> => {
  const [picked, partyId] = value.split(":");
  const role = ROLES.find((candidate) => candidate === picked) ?? CLAIM_PARTY_ROLE.SUPPLIER;
  return { role, supplierPartyId: partyId ?? null };
};

const ClaimRow: React.FC<{ claim: ClaimDraft; index: number; line: ReconciliationLine; parties: Parties; disabled: boolean; onChange: (claim: ClaimDraft | null) => void }> = ({ claim, index, line, parties, disabled, onChange }) => {
  const set = (patch: Partial<ClaimDraft>) => onChange({ ...claim, ...patch });
  const rateBad = claim.rate !== "" && !Number.isFinite(ratePaisaOf(claim.rate));
  const id = `${line.lineId}-${claim.key}`;
  return (
    <li className="mur-claim">
      <label className="mur-claim-field mur-claim-field--wide">
        <span>{text.claimAgainst}</span>
        <select className="form-input" value={valueOf(claim)} disabled={disabled} onChange={(event) => set(chosen(event.target.value))}>
          <option value="" disabled>—</option>
          {options(line, parties).map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
          ))}
        </select>
      </label>
      <label className="mur-claim-field">
        <span>{text.claimPairs}</span>
        <input id={`${id}-pairs`} className="form-input mur-count" type="text" inputMode="numeric" placeholder="0" value={claim.pairs} disabled={disabled} onChange={(event) => set({ pairs: cleanCount(event.target.value) })} />
      </label>
      <label className="mur-claim-field">
        <span>{text.claimRate}</span>
        <input className="form-input mur-money" type="text" inputMode="decimal" placeholder="0" value={claim.rate} disabled={disabled} aria-invalid={rateBad} onChange={(event) => set({ rate: cleanRupees(event.target.value) })} />
      </label>
      <div className="mur-claim-field mur-claim-total">
        <span>{text.claimTotal}</span>
        <b>Rs {formatMoney(fromPaisa(claimTotalPaisa(claim)))}</b>
      </div>
      <label className="mur-claim-field mur-claim-field--reason">
        <span>{text.claimReason}</span>
        <input className="form-input" type="text" value={claim.reason} placeholder={text.reasonPlaceholder} disabled={disabled} onChange={(event) => set({ reason: event.target.value })} />
      </label>
      <button type="button" className="mur-claim-remove" aria-label={text.removeClaim(index + 1)} disabled={disabled} onClick={() => onChange(null)}>
        ×
      </button>
      {rateBad ? <p className="mur-field-problem" role="alert">⚠ {text.rateInvalid}</p> : null}
    </li>
  );
};

export const ClaimRows: React.FC<{ line: ReconciliationLine; claims: ClaimDraft[]; parties: Parties; disabled: boolean; onChange: (claims: ClaimDraft[]) => void }> = ({ line, claims, parties, disabled, onChange }) => (
  <div className="mur-action mur-action--claims">
    <div className="mur-action-label">
      <span className="mur-action-title">{text.claimsTitle}</span>
      <span className="mur-action-hint">{text.claimsHint}</span>
    </div>
    {claims.length > 0 ? (
      <ul className="mur-claims">
        {claims.map((claim, index) => (
          <ClaimRow
            key={claim.key}
            claim={claim}
            index={index}
            line={line}
            parties={parties}
            disabled={disabled}
            onChange={(next) => onChange(next ? claims.map((item) => (item.key === claim.key ? next : item)) : claims.filter((item) => item.key !== claim.key))}
          />
        ))}
      </ul>
    ) : null}
    <button type="button" className="btn btn-secondary btn-sm mur-add-claim" disabled={disabled} onClick={() => onChange([...claims, newClaim(line)])}>
      {text.addClaim}
    </button>
  </div>
);
