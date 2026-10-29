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
 * Who raw material may be RECEIVED from — a Move In session or a by-hand move in: suppliers only
 * (owner, 0.3.9). Labels are printed for suppliers alone and a packet is received only into its
 * own supplier's session, so a session for anyone else could never receive anything. Material
 * coming back from a contractor is Return Upper, inside its machine program, with no session.
 */
export const RAW_MATERIAL_RECEIPT_PARTY_TYPES: readonly PartyType[] = ['SUPPLIER'];

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
