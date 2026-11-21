-- Undoes 114. REFUSED (the CHECK fails and the run rolls back whole) while any statement is withdrawn: without the
-- columns a withdrawn statement would silently count as in force again.

CREATE TABLE undo_114_guard (what TEXT NOT NULL, n INTEGER NOT NULL CHECK (n = 0));
INSERT INTO undo_114_guard (what, n) SELECT 'withdrawn archive statements', COUNT(*) FROM ledger_archive_statements WHERE withdrawn_at IS NOT NULL;
DROP TABLE undo_114_guard;

DROP INDEX IF EXISTS idx_ledger_archive_statements_withdrawn;
DROP INDEX IF EXISTS idx_ledger_archive_statements_content;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_archive_statements_content ON ledger_archive_statements(party_id, content_hash);
ALTER TABLE ledger_archive_statements DROP COLUMN withdrawal_request_id;
ALTER TABLE ledger_archive_statements DROP COLUMN withdrawal_reason;
ALTER TABLE ledger_archive_statements DROP COLUMN withdrawn_by;
ALTER TABLE ledger_archive_statements DROP COLUMN withdrawn_at;
