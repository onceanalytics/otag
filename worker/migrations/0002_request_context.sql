-- Request context columns, matching Once Analytics 0.2.1 (migrations/0.2.1.sql
-- there). Appended after created_at, as there, so the two events tables stay
-- column for column. Derived at ingest in src/ingest-context.ts, which is a
-- byte-for-byte copy of the Once Analytics file. The raw user agent is never
-- stored.
--
-- in_app: the app whose in-app browser opened the page (whatsapp, instagram, ...)
-- city: Cloudflare's request.cf.city
-- lang: primary subtag of the first Accept-Language entry, lowercase (pl)
-- dc: 1 from a cloud or hosting network, 0 not, NULL when unknown
ALTER TABLE events ADD COLUMN in_app TEXT;
ALTER TABLE events ADD COLUMN city TEXT;
ALTER TABLE events ADD COLUMN lang TEXT;
ALTER TABLE events ADD COLUMN dc INTEGER;
