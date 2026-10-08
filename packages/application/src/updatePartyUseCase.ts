import type { UpdatePartyInput } from "@erp/domain";

export interface UpdatePartyDeps {
  db: {
    getParty(id: string): Promise<{ id: string; partyName: string } | null>;
    getPartyByName(name: string): Promise<{ id: string } | null>;
    updateParty(id: string, input: Partial<UpdatePartyInput>): Promise<void>;
  };
}

export interface UpdatePartyResult {
  accepted: boolean;
  reason?: string;
}

export class UpdatePartyUseCase {
  constructor(private readonly deps: UpdatePartyDeps) {}

  async execute(input: UpdatePartyInput): Promise<UpdatePartyResult> {
    try {
      // Validate party exists
      const existing = await this.deps.db.getParty(input.id);
      if (!existing) {
        return {
          accepted: false,
          reason: "Party not found.",
        };
      }

      // Validate party name if provided
      if (input.partyName !== undefined && input.partyName.trim()) {
        if (input.partyName !== existing.partyName) {
          const duplicate = await this.deps.db.getPartyByName(input.partyName);
          if (duplicate && duplicate.id !== input.id) {
            return {
              accepted: false,
              reason: "A party with this name already exists.",
            };
          }
        }
      }

      // Validate email if provided
      if (input.email !== undefined && input.email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(input.email)) {
          return {
            accepted: false,
            reason: "Invalid email format.",
          };
        }
      }

      // Validate phone numbers
      if (input.mobileNumber !== undefined && input.mobileNumber) {
        const phoneRegex = /^\d{10,15}$/;
        if (!phoneRegex.test(input.mobileNumber.replace(/\D/g, ""))) {
          return {
            accepted: false,
            reason: "Mobile number must be 10-15 digits.",
          };
        }
      }

      if (input.phoneNumber !== undefined && input.phoneNumber) {
        const phoneRegex = /^\d{10,15}$/;
        if (!phoneRegex.test(input.phoneNumber.replace(/\D/g, ""))) {
          return {
            accepted: false,
            reason: "Phone number must be 10-15 digits.",
          };
        }
      }

      if (input.whatsAppNumber !== undefined && input.whatsAppNumber) {
        const phoneRegex = /^\d{10,15}$/;
        if (!phoneRegex.test(input.whatsAppNumber.replace(/\D/g, ""))) {
          return {
            accepted: false,
            reason: "WhatsApp number must be 10-15 digits.",
          };
        }
      }

      // Update party
      await this.deps.db.updateParty(input.id, input);

      return {
        accepted: true,
      };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : "An error occurred while updating party.",
      };
    }
  }
}
