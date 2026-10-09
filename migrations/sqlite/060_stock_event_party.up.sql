-- Who a stock movement was with.
--
-- Raw material is received supplier-at-a-time: a scanning session is bound to one party
-- (migration 038), so every scanned packet is traceable to whoever delivered it. Material that
-- arrives WITHOUT labels - nawaar on a roll, loose stock - is taken in by hand instead, and the
-- owner asked on 2026-10-09 that it still name its supplier. A name kept only inside the free
-- text note cannot be asked a question later, so it goes in a column of its own.
--
-- Nullable, and nothing is back-filled. Every movement recorded before today either carried its
-- party on the scan event it came from (raw_material_qr_events) or genuinely had none - an
-- approved stock correction is nobody's delivery. Inventing a supplier for those would be
-- putting a fact into the ledger that no one recorded.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE inventory_stock_events ADD COLUMN party_id TEXT REFERENCES parties(id);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_events_party
  ON inventory_stock_events(party_id, created_at DESC);
