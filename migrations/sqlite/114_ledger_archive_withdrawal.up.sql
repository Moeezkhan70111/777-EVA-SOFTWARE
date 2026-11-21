-- An imported old-ledger batch can be WITHDRAWN (docs/53): by an administrator, with a reason, kept for the record.
--
-- A withdrawn statement keeps every row exactly as it was imported. It is only marked: who withdrew it, when, why, and
-- under which request. The ledger screens, the reconciliation, the duplicate checks and the opening-balance proposals
-- then leave it out, so the same file can be imported again once it has been put right. Nothing is deleted.
--
-- The archive is not accounting, so withdrawing one changes no balance, cash book, stock figure or voucher. A batch whose
-- statement an opening balance was checked against cannot be withdrawn while that opening balance is posted: the
-- application refuses it (database/ledgerArchive.ts), so the reconciliation never points at a withdrawn archive.
--
-- Replicated as before: a withdrawal is a new revision of the same LEDGER_ARCHIVE_STATEMENT record under ACCOUNTS. No
-- cloud migration: the record's body carries the new columns, and 034 already accepts the type.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE ledger_archive_statements ADD COLUMN withdrawn_at TEXT;

ALTER TABLE ledger_archive_statements ADD COLUMN withdrawn_by TEXT;

ALTER TABLE ledger_archive_statements ADD COLUMN withdrawal_reason TEXT;

ALTER TABLE ledger_archive_statements ADD COLUMN withdrawal_request_id TEXT;

-- The same statement may be stored once among those still in force. A withdrawn one no longer blocks a corrected import.
DROP INDEX IF EXISTS idx_ledger_archive_statements_content;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_archive_statements_content ON ledger_archive_statements(party_id, content_hash) WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_archive_statements_withdrawn ON ledger_archive_statements(withdrawn_at);
