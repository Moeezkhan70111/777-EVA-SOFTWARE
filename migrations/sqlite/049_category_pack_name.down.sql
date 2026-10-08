-- SQLite before 3.35 cannot drop a column. Leaving pack_name in place is harmless: nothing reads
-- it once the code that writes and reads it is rolled back.
SELECT 1;
