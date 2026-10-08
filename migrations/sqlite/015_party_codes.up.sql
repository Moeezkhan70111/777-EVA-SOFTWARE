ALTER TABLE parties ADD COLUMN party_code TEXT;
UPDATE parties SET party_code = 'PTY-' || printf('%06d', rowid) WHERE party_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_party_code ON parties(party_code);
