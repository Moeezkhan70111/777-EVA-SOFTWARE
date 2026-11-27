-- Undo 043: the cloud forgets ARTICLE_COLOR_REQUEST. Only while no request is in leased_records or the log: the
-- foreign keys refuse otherwise, and nothing is deleted. Colours already added stay: they are Product Master.

begin;

delete from public.leased_record_types where aggregate_type = 'ARTICLE_COLOR_REQUEST';
delete from public.sync_aggregate_types where aggregate_type = 'ARTICLE_COLOR_REQUEST';

commit;
