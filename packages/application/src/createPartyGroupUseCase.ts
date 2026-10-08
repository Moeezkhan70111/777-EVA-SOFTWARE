import type { CreatePartyGroupInput } from "@erp/domain";

export interface CreatePartyGroupDeps {
  db: {
    getPartyGroupByName(name: string): Promise<{ id: string } | null>;
    createPartyGroup(input: CreatePartyGroupInput): Promise<string>;
  };
}

export interface CreatePartyGroupResult {
  accepted: boolean;
  groupId?: string;
  reason?: string;
}

export class CreatePartyGroupUseCase {
  constructor(private readonly deps: CreatePartyGroupDeps) {}

  async execute(input: CreatePartyGroupInput): Promise<CreatePartyGroupResult> {
    try {
      // Validation
      if (!input.groupName || !input.groupName.trim()) {
        return {
          accepted: false,
          reason: "Group name is required.",
        };
      }

      // Check for duplicates
      const existing = await this.deps.db.getPartyGroupByName(input.groupName);
      if (existing) {
        return {
          accepted: false,
          reason: "A group with this name already exists.",
        };
      }

      // Create group
      const groupId = await this.deps.db.createPartyGroup(input);

      return {
        accepted: true,
        groupId,
      };
    } catch (error) {
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : "An error occurred while creating group.",
      };
    }
  }
}
