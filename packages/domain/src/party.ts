export type PartyType = 'CUSTOMER' | 'SUPPLIER' | 'CONTRACTOR' | 'DISTRIBUTOR' | 'DEALER' | 'TRANSPORTER';

/** The party type a machine's two contractors must have (machine contractor, packing contractor). */
export const CONTRACTOR_PARTY_TYPE: PartyType = 'CONTRACTOR';

/**
 * Who a packet may be moved out TO on the Scan Out station: suppliers and contractors (owner
 * request, 0.3.6). One list, read by the use case that enforces it and the screen that offers it.
 */
export const RAW_MATERIAL_ISSUE_PARTY_TYPES: readonly PartyType[] = ['SUPPLIER', CONTRACTOR_PARTY_TYPE];

export const isRawMaterialIssuePartyType = (partyType: string): boolean =>
  (RAW_MATERIAL_ISSUE_PARTY_TYPES as readonly string[]).includes(partyType);

/**
 * Who raw material may be RECEIVED from — a Move In session, a by-hand move in, and the parties
 * labels are printed for: suppliers and contractors (owner, 0.4.1; suppliers only in 0.3.9). One
 * list for all three, because a packet is received only into a session for the party its label
 * names: a party labels cannot be printed for could never receive anything.
 *
 * Material a contractor brings back FROM A MACHINE PROGRAM is still Return Upper, inside the
 * program, so the program's reconciliation sees it. Receiving it here instead would count it as a
 * new delivery and leave the program short.
 */
export const RAW_MATERIAL_RECEIPT_PARTY_TYPES: readonly PartyType[] = ['SUPPLIER', CONTRACTOR_PARTY_TYPE];

export const isRawMaterialReceiptPartyType = (partyType: string): boolean =>
  (RAW_MATERIAL_RECEIPT_PARTY_TYPES as readonly string[]).includes(partyType);
export type PartyStatus = 'ACTIVE' | 'INACTIVE';

export interface PartyGroup {
  id: string;
  groupName: string;
  description?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Party {
  id: string;
  partyName: string;
  partyType: PartyType;
  contactPerson?: string;
  mobileNumber?: string;
  whatsAppNumber?: string;
  phoneNumber?: string;
  email?: string;
  address?: string;
  city?: string;
  partyGroupId?: string;
  remarks?: string;
  status: PartyStatus;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePartyInput {
  partyName: string;
  partyType?: PartyType;
  contactPerson?: string;
  mobileNumber?: string;
  whatsAppNumber?: string;
  phoneNumber?: string;
  email?: string;
  address?: string;
  city?: string;
  partyGroupId?: string;
  remarks?: string;
  status?: PartyStatus;
}

export interface UpdatePartyInput extends CreatePartyInput {
  id: string;
}

export interface CreatePartyGroupInput {
  groupName: string;
  description?: string;
}
