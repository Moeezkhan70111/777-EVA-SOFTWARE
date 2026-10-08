import { addMoney, subtractMoney } from "@erp/domain";

// The party's credit position once this bill is added — the same arithmetic the database
// runs for the balance-limit check on save (packages/data sales.ts createSaleVoucher), shown
// ahead of time so the desk is not surprised by a refusal.

export interface PartyCredit {
  balance: number;
  /** null: the party has no credit limit. */
  limit: number | null;
  projected: number;
  /** Room left under the limit before this bill; null when there is no limit. */
  available: number | null;
  /** How far past the limit the projected balance lands; 0 when it fits or there is no limit. */
  exceedsBy: number;
}

export const projectPartyCredit = (input: { balance: number; limit: number | null; billTotal: number }): PartyCredit => {
  const projected = addMoney(input.balance, input.billTotal);
  if (input.limit === null) return { balance: input.balance, limit: null, projected, available: null, exceedsBy: 0 };
  return {
    balance: input.balance,
    limit: input.limit,
    projected,
    available: Math.max(0, subtractMoney(input.limit, input.balance)),
    exceedsBy: Math.max(0, subtractMoney(projected, input.limit)),
  };
};
