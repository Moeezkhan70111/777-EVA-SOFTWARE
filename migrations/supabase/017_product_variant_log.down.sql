-- Reverses 017: variants stop reaching the log.
--
-- The log rows 017 wrote stay. The log is append-only by design (trg_sync_event_log_immutable), and
-- a computer that has read them holds those variants rightly. Only future variants stop travelling.

drop trigger if exists trg_product_variants_log on public.product_variants;
drop function if exists public.log_product_variant_insert();
