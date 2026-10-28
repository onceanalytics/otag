-- Three columns, matching Once Analytics 0.2.1 (migrations/0.2.1.sql there).
-- Appended after asn, as there, so the two events tables stay column for
-- column. Rows from before this migration keep NULL in all three.
--
-- tz: the browser's time zone as otag 0.3.2 reports it (z), Europe/Warsaw.
--     Checked in src/ingest-context.ts (timeZoneOf); NULL when absent or not
--     a zone name.
-- colo: Cloudflare's request.cf.colo, the data center that took the request (WAW).
-- rtt: Cloudflare's request.cf.clientTcpRtt rounded to 10 ms; NULL when there
--     is none (often on HTTP/3).
ALTER TABLE events ADD COLUMN tz TEXT;
ALTER TABLE events ADD COLUMN colo TEXT;
ALTER TABLE events ADD COLUMN rtt INTEGER;
