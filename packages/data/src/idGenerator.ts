import type { IdGenerator } from "@erp/application";

export class UuidGenerator implements IdGenerator {
  nextId(): string {
    return crypto.randomUUID();
  }
}
