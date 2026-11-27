-- Undo 119: nothing to undo in the tables. 119 only queued customers with discount rules for sending once. A 118 build
-- does not send rules (its record spec has no such children), so a mark left behind sends the customer alone.
SELECT 1;
