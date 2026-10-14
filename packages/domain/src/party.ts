export type PartyType = 'CUSTOMER' | 'SUPPLIER' | 'CONTRACTOR' | 'DISTRIBUTOR' | 'DEALER' | 'TRANSPORTER';

/** The party type a machine's two contractors must have (machine contractor, packing contractor). */
export const CONTRACTOR_PARTY_TYPE: PartyType = 'CONTRACTOR';
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
