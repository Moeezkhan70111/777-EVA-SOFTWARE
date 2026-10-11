-- Reverses 061 by dropping only the two indexes it created
--
-- Nothing else is touched. No row, no column and no other index is affected, and the two
-- tables return to exactly the shape migrations 038 and 039 left them in
--
-- No semicolons in this comment block - the migration runner splits statements on them

DROP INDEX IF EXISTS idx_rm_receiving_sessions_number;

DROP INDEX IF EXISTS idx_rm_issue_sessions_number;
