-- A sale voucher line remembers whether it was billed at the NORMAL or the B-TYPE rate.
-- Until now the price type lived only on screen: a saved B-TYPE line reopened as NORMAL,
-- so re-resolving the party's discount when a bill is reopened would have handed it a
-- less it must never carry. Existing rows default to NORMAL (the rate they were saved at
-- is the authoritative figure either way). Additive only. (No semicolons in comments: the
-- migration runner splits on them.)
ALTER TABLE sale_voucher_line_items ADD COLUMN price_type TEXT NOT NULL DEFAULT 'NORMAL' CHECK (price_type IN ('NORMAL','B_TYPE'));
