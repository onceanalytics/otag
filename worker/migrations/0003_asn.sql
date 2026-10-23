-- The network column, matching Once Analytics 0.2.0 (migrations/0.2.0.sql
-- there). Appended after dc, as there, so the two events tables stay column for
-- column. Derived at ingest in src/ingest-context.ts.
--
-- asn: Cloudflare's request.cf.asn. Kept so the datacenter flag (dc), decided
-- once at ingest, can be recomputed later against a longer list of networks.
ALTER TABLE events ADD COLUMN asn INTEGER;
