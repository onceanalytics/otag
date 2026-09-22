# otag

Open-source JS tracking script, alternative to GA4 gtag/js or gtm.js.
Tracks `page_view` and a number of default events like `click` or `form_submit`.

Supports custom events via `dataLayer` and is not setting or using any cookies by default.

Comes with a collection endpoint that runs as a Cloudflare Worker and stores raw events in D1.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/onceanalytics/otag/tree/main/worker)

Use the button above to get your tracker live, and use a SQL client or agent to query your D1 data directly.

About 1.3KB over the wire. MIT licensed.

## What it sends

One POST per event, to your own endpoint. An envelope, and the event's own
parameters in `b`:

```json
{
  "e": "click",
  "p": "/pricing",
  "d": "yoursite.com",
  "r": "https://news.ycombinator.com/",
  "c": { "analytics_storage": "granted" },
  "b": { "link_id": "book-desk", "link_text": "Book a desk", "link_url": "/signup" }
}
```

| Key | |
|---|---|
| `e` | event name |
| `p` | path and query |
| `d` | domain the page was served from |
| `r` | referrer, on every event |
| `c` | consent state, omitted entirely when no consent command was seen |
| `b` | the event's parameters, omitted when it has none |

That is the whole payload, and the only request the script makes.

The envelope is how the request is routed, and the server needs all of it before
the event name means anything: `d` picks the site, `c` decides the identity. `b`
is what happened, under [GA4's parameter names](#naming) - and a `page_view`,
having no parameters of its own, has no `b` at all.

The script makes no policy decisions. It reports what it observed, including the
consent state, and the server decides what to keep, what to drop and how to
identify visitors.

## What it stores

No cookies, no `localStorage`, no `sessionStorage`. The script never reads or
writes browser storage, and has no identifier of its own.

Visitors are identified on the server, under one of four privacy modes: an
anonymous per-request identifier, a daily-rotating hash, a stable hash, or a
first-party cookie. Every hashed mode includes the site, so two sites never share
an identity.

No fingerprinting, no canvas, no device enumeration.

## What it collects

| Event | When |
|---|---|
| `page_view` | page load, and when an SPA changes path |
| `click` | clicks on links, buttons, inputs and `role="button"` |
| `form_start` | first focus inside a form, once per form per page |
| `form_submit` | form submissions |
| `exception` | uncaught errors and unhandled promise rejections |
| `web_vitals` | once, when the page is hidden - LCP, CLS and INP. Sampled at 25% |
| *your own* | anything pushed to `dataLayer`, and `gtag('event', …)` |

Text captured from an element is sent as-is, truncated at 50 characters. Redaction
happens server-side.

## Naming

Event and parameter names follow GA4's, so a site that already knows GA4 does not
have to learn a second vocabulary:

- [Enhanced measurement events](https://support.google.com/analytics/answer/9216061?hl=en)
- [Recommended events](https://support.google.com/analytics/answer/9267735?hl=en)

otag sends a small subset of those events, and uses GA4's name for whatever it
sends rather than a synonym.
`page_view`, `click`, `form_start` and `form_submit` are enhanced measurement
events, `exception` is GA4's name for a JS error, and what a site pushes to
`dataLayer` passes through under its own name, so a `purchase` or a `login`
arrives already conventional.

Inside `b` the names are GA4's, spelled out. Nothing translates them later:

| Event | `b` |
|---|---|
| `page_view` | none |
| `click` | `link_id`, `link_text`, `link_url` |
| `form_start`, `form_submit` | `form_id`, `form_name`, `form_destination` |
| `exception` | `description`, `source`, `stack` |
| `web_vitals` | `lcp`, `cls`, `inp`, `rate` |
| *your own* | whatever you pushed |

The envelope keeps its short keys because it is transport rather than data:
`p` and `d` are GA4's `page_location` split in two, and `r` is `page_referrer`.

Three deviations, all deliberate and all worth knowing. GA4's `click` fires only
on outbound links; otag's fires on any interactive element, because which clicks
matter is a server decision here and a broader capture is the one that can still
be narrowed later. GA4 counts `form_start` once per form per *session*, and the
script has no session, so it sends one per form per page load and lets the server
collapse them. And `web_vitals` has no GA4 equivalent at all - Google's own
web-vitals library sends one event per metric, where otag sends one report per
page.

`exception` carries `description`, `source` and `stack`. GA4's third parameter,
`fatal`, is not sent: neither an uncaught error nor a rejected promise stops a
page, so it would be a constant `false` on every event. No element tag name is
sent on a `click` either - GA4 has no parameter for one, and no report read it.

A new event takes its name from those two lists if either has one for it, and a
plain snake_case name that collides with neither if they do not.

## Install

```html
<script src="https://your-worker.example.com/script.js" defer></script>
```

The endpoint is the script's own origin plus `/t`. There is nothing to
configure, and the served bytes are identical for every site.

## The endpoint

`worker/` is a Cloudflare Worker that serves the script, takes the events and
writes them to a D1 database. It has no dashboard and no reports: the data is
read with SQL, by a client or an agent, through a D1 read token.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/onceanalytics/otag/tree/main/worker)

The button creates the Worker and its database in your own Cloudflare account,
runs the migration and deploys. It asks for nothing: the salt for the visitor
hash is generated on the first request and kept in the database, and sites name
themselves.

| Route | |
|---|---|
| `GET /` | installation instructions, the event count, and queries to copy |
| `GET /script.js` | the script above |
| `POST /t` | one event, one row |
| `GET`, `POST /optout` | the opt-out cookie |

### One endpoint, any number of sites

`site_id` is the hostname the page was served from, lowercased and without a
leading `www.` or a port. `example.com`, `www.example.com` and
`www.example.com:8443` are one site; `blog.example.com` is another. The endpoint's
own hostname is used only when an event arrives without one, which otag never
does.

So the same script tag on five sites fills one database with five `site_id`
values, and none of them has to be configured. Once Analytics resolves the same
value from the same field, which is what makes moving there exact rather than
approximate.

Visitors are identified by `SHA-256(ip | user-agent | site | date | salt)`, which
is the only mode here. Once Analytics has four and picks per site; with one there
is no setting to read, so an event costs one insert and no query.

The site is in the hash, so two of your sites in one database never share an
identity: the same person on both, on the same day, is two unrelated hashes. The
date rotates it at midnight UTC, and the salt is generated on first use and kept
in the database.

### Reading it

```sql
SELECT date(created_at) AS day, COUNT(*) AS views
FROM events
WHERE site_id = 'example.com'
  AND event_name = 'page_view' AND is_bot = 0
  AND created_at >= datetime('now', '-30 days')
GROUP BY day ORDER BY day;
```

Hashes rotate at UTC midnight, so `COUNT(DISTINCT visitor_hash)` counts people
within one day and visitor-days across several, per site. There are no sessions in the
table; grouping events into visits is a query, and different queries will
disagree.

On Cloudflare's free plan, going over the daily D1 read allowance blocks every
query on the account, **including the insert on this endpoint**, until 00:00 UTC.
An agent looping thirty-day scans reaches that limit quickly, so filter on
`created_at`. The free plan writes 100,000 rows a day, about 23,000 pageviews
with the one index this ships with.

### Running it locally

```bash
cd worker
npm install
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

### Leaving it

The `events` table matches [Once Analytics](https://onceanalytics.com) column for
column, so moving to the paid product points a different worker at the same
database. Nothing is exported and nothing is re-collected.

## Consent

otag understands Google Consent Mode v2 and assumes nothing. If your CMP never
pushes a consent command, consent is *unset* rather than denied.

Whatever it observes is reported on every event as `c`. The server enforces it,
choosing the privacy mode for that request and deciding what to store.

## Build

```bash
npm install
npm run build      # dist/otag.js, minified, prints raw/gzip/brotli sizes
npm run dev        # unminified
npm run typecheck
npm test           # builds, then runs the behaviour suite
```

`npm run build` also writes `worker/src/otag.generated.ts`, the same bytes as a
string, because a Worker cannot read a file at runtime and Cloudflare builds
`worker/` on its own. It is committed. `npm run check:generated` rebuilds and
fails if the committed copy has drifted, which is what CI runs. `npm run dev`
leaves it alone, so unminified output never reaches it.

## Try it

```bash
npm run build
open test-site/index.html
```

No server needed. The page intercepts the requests and renders each payload:
click things, submit the form, push to `dataLayer`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full detail.
