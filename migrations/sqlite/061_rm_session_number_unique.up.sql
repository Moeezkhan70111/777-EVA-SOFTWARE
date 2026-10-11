-- Raw-material session numbers must be unique, the same way store session numbers already are
--
-- store_receiving_sessions and store_move_out_sessions were created by migrations 024 and 025
-- with "session_number INTEGER NOT NULL UNIQUE". raw_material_receiving_sessions and
-- raw_material_issue_sessions were created later by migrations 038 and 039 with the identical
-- column shape but without UNIQUE. Nothing in the data model wants duplicates - the allocator
-- is a global MAX(session_number) + 1 and the number is shown to operators as RMI-000001 and
-- RMO-000001 - so the omission leaves duplicates possible and, unlike every other numbered
-- document in the system, silently accepted
--
-- A unique INDEX rather than a rebuilt table with an inline constraint - the two are
-- equivalent to the query planner and to correctness, and adding an index cannot disturb the
-- rows, the foreign keys or the column order of a table that already holds live sessions
--
-- raw_material_qrs is deliberately NOT touched - it already carries UNIQUE(party_id, item_id,
-- sequence) as a table-level constraint
--
-- IF THIS MIGRATION FAILS the database already holds duplicate session numbers. The whole
-- migration run is one transaction, so nothing is written and no row is altered - see
-- docs/26-phase-1a-migration-plan.md for the preflight queries and what to do next. Nothing
-- here renumbers, merges or deletes anything
--
-- No semicolons in this comment block - the migration runner splits statements on them

CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_receiving_sessions_number
  ON raw_material_receiving_sessions(session_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_issue_sessions_number
  ON raw_material_issue_sessions(session_number);
