import type { Party } from "@erp/domain";

export interface ListPartiesQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  city?: string;
  groupId?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface ListPartiesPage<TRow> {
  rows: TRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListPartiesDeps<TRow> {
  db: {
    listParties(query: ListPartiesQuery): Promise<ListPartiesPage<TRow>>;
  };
}

export class ListPartiesUseCase<TRow = Party> {
  constructor(private readonly deps: ListPartiesDeps<TRow>) {}

  async execute(query: ListPartiesQuery = {}): Promise<ListPartiesPage<TRow>> {
    return this.deps.db.listParties(query);
  }
}
