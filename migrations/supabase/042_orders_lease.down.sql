-- Undoes 042: customer orders go back under SALES_DISPATCH, and the ORDERS lease is removed.
--
-- Refused while anything names ORDERS: domain_lease_events once it has been granted (a grant is history and is never
-- deleted), so after a grant this is not reversible by rows alone, by design. Before a grant it removes cleanly.
-- Order records and the log are not touched. After it, order revisions are accepted again only from SALES_DISPATCH's
-- holder, so a computer that wrote orders under ORDERS must stop before this runs.

begin;

update public.leased_record_types
   set lease_domain = 'SALES_DISPATCH'
 where aggregate_type in ('CUSTOMER_ORDER');

delete from public.domain_leases where domain = 'ORDERS';
delete from public.lease_domains where domain = 'ORDERS';

commit;
