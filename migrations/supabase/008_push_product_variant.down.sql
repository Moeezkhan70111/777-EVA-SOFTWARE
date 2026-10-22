-- Removes the product-variant push.
--
-- Safe in the sense that matters: it drops a function and nothing else. No product_variants row
-- is touched, and the direct insert on that table stays revoked, so reversing this does not open
-- a write path -- it closes the only one a client had.
--
-- What it loses is the cure for UNKNOWN_PRODUCT_VARIANT. After this, a carton of a product the
-- cloud has not been given is refused until somebody inserts the variant by hand, which is the
-- behaviour 008 exists to end. A client still carrying PRODUCT_VARIANT rows in its outbox will
-- have them refused as undeliverable rather than silently dropped.
--
-- Nothing executes this file: Supabase migrations here are applied by hand and only the .up.sql
-- is ever pasted.
--
-- (No semicolons in comments: the note above is prose, not SQL.)

begin;

drop function if exists public.push_product_variant(bigint, uuid, jsonb);

commit;
