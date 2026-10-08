-- Gatepass transport details, as printed on the paper book:
--   بلٹی نمبر  → bilty_number  (transporter's receipt number)
--   بزریعہ     → transport_via (carrier / vehicle the goods travel by)
-- Both optional: they are often unknown when the document is cut and written in by hand.
-- Additive only. (No semicolons in comments: the migration runner splits on them.)
ALTER TABLE gatepasses ADD COLUMN bilty_number TEXT;
ALTER TABLE gatepasses ADD COLUMN transport_via TEXT;
