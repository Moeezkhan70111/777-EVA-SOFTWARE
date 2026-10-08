import type { CreatePartyInput } from "@erp/domain";

export interface CreatePartyDeps {
  db: {
    getPartyByName(name: string): Promise<{ id: string } | null>;
    createParty(input: CreatePartyInput): Promise<string>;
  };
}

export interface CreatePartyResult {
  accepted: boolean;
  partyId?: string;
  reason?: string;
}

export class CreatePartyUseCase {
  constructor(private readonly deps: CreatePartyDeps) {}

  async execute(input: CreatePartyInput): Promise<CreatePartyResult> {
    try {
      // Validation
      if (!input.partyName || !input.partyName.trim()) {
        return {
          accepted: false,
          reason: "Party name is required.",
        };
      }

      // Check for duplicates
      const existing = await this.deps.db.getPartyByName(input.partyName);
      if (existing) {
        return {
          accepted: false,
          reason: "A party with this name already exists.",
        };
      }

      // Validate email if provided
      if (input.email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(input.email)) {
          return {
            accepted: false,
            reason: "Invalid email format.",
          };
        }
      }

      // Validate phone numbers if provided
      if (input.mobileNumber) {
        const phoneRegex = /^\d{10,15}$/;
        if (!phoneRegex.test(input.mobileNumber.replace(/\D/g, ""))) {
          return {
            accepted: false,
            reason: "Mobile number must be 10-15 digits.",
          };
        }
      }

      if (input.phoneNumber) {
        const phoneRegex = /^\d{10,15}$/;
        if (!phoneRegex.test(input.phoneNumber.replace(/\D/g, ""))) {
          return {
            accepted: false,
            reason: "Phone number must be 10-15 digits.",
          };
        }
      }

      if (input.whatsAppNumber) {
        const phoneRegex = /^\d{10,15}$/;
        if (!phoneRegex.test(input.whatsAppNumber.replace(/\D/g, ""))) {
          return {
            accepted: false,
            reason: "WhatsApp number must be 10-15 digits.",
          };
        }
      }

      // Create party
      const partyId = await this.deps.db.createParty(input);

      return {
        accepted: true,
        partyId,
      };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : "An error occurred while creating party.",
      };
    }
  }
}
