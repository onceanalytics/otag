# otag

Open-source JS first-party tracking script, alternative to GA4 gtag/js or gtm.js.
Tracks `page_view` and a number of default events like `click` or `form_submit`.

Supports custom events via `dataLayer` and is not setting or using any cookies by default.

Comes with a collection endpoint that runs as a Cloudflare Worker and stores raw events in D1.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/onceanalytics/otag/tree/main/worker)

Use the button above to get your tracker live (or the wrangler CLI instructions below), and use a SQL client or agent to query your D1 data directly.

Browser JS is about 2KB gzipped. MIT license.

## Install

### 1. Deploy the endpoint

The button above creates a Worker and a D1 database in your Cloudflare account, applies
`worker/migrations/0001_init.sql` and deploys. No configuration is required.

CLI equivalent:

```bash
git clone https://github.com/onceanalytics/otag
cd otag/worker
npm install
npx wrangler login
npx wrangler d1 create otag-events     # prints a database_id
```

Put the id in `wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "otag-events", "database_id": "paste-it-here" }
]
```

```bash
npm run deploy      # wrangler d1 migrations apply DB --remote && wrangler deploy
```

Routes:

| Method and path | Response |
|---|---|
| `GET /` | install page: script tag, event count, example queries |
| `GET /script.js` | the script. `Cache-Control: public, max-age=3600`, `X-Otag-Version` |
| `POST /t` | `{"ok":true}`, and one row in `events`. `{"ok":true,"excluded":true}` when opted out |
| `GET /optout` | `{"optedOut":bool}` |
| `POST /optout` | toggles the `oa_optout` cookie, returns the new state |

### 2. Add the script

```html
<script src="https://your-worker.example.com/script.js" defer></script>
```

The script reads `document.currentScript.src` and posts to that origin plus `/t`.

Requests to a `workers.dev` origin are cross-site from the tracked page and are commonly
blocked. For first-party requests, bind the Worker to a subdomain of the tracked site and
deploy again:

```jsonc
"routes": [
  { "pattern": "t.example.com", "custom_domain": true }
]
```

The domain has to be on Cloudflare.

## Events and parameters

| Event | When |
|---|---|
| `page_view` | page load, and when an SPA changes path |
| `click` | clicks on links, buttons, form fields, `<summary>` and ARIA buttons, links, tabs and menu items, and on anything inside an element with an id |
| `form_start` | first focus inside a form, once per form per page |
| `form_submit` | form submissions |
| `exception` | uncaught errors and unhandled promise rejections |
| `web_vitals` | once, when the page is hidden - LCP, CLS and INP. Sampled at 25% |
| `engaged` | once per page load, at the first real input: a pointer press, touch, scroll, key, or mouse move. Not sampled |
| *your own* | anything pushed to `dataLayer`, and `gtag('event', …)` |

Parameters, sent as `b` and stored as JSON in `events.event_data`:

| Event | `b` |
|---|---|
| `page_view` | none |
| `click` | `link_id`, `link_text`, `link_url` |
| `form_start`, `form_submit` | `form_id`, `form_name`, `form_destination` |
| `exception` | `description`, `source`, `stack` |
| `web_vitals` | `lcp`, `cls`, `inp`, `rate` |
| `engaged` | `t`: ms from the page first being visible to the input; `k`: which input, `p` pointer press, `t` touch, `s` scroll, `k` key, `m` mouse move |
| *your own* | whatever you pushed |

Event and parameter names follow GA4's
[enhanced measurement](https://support.google.com/analytics/answer/9216061?hl=en) and
[recommended events](https://support.google.com/analytics/answer/9267735?hl=en) lists.
Differences are listed in
[ARCHITECTURE.md](ARCHITECTURE.md#where-otag-differs-from-ga4).

**Storage:** none. The script does not read or write cookies, `localStorage` or
`sessionStorage`, and holds no identifier.

**Device facts:** the browser's time zone (`z`, below) and whether `navigator.webdriver`
is set (`w`). Not the screen size, viewport or pixel ratio.

**Prerendering:** a page Chrome prerenders sends nothing until it is shown; a
prerender nobody opens sends nothing at all. A page opened in a background tab
sends its `page_view` at once.

**Text capture:** element text is sent as-is, truncated at 50 characters. Redaction is
server-side.

## Reading the data

### Sites

`site_id` is the page hostname, normalised: lowercased, trailing dot removed, port
removed, leading `www.` removed.

| `d` in the payload | `site_id` |
|---|---|
| `example.com` | `example.com` |
| `WWW.Example.com` | `example.com` |
| `www.example.com:8443` | `example.com` |
| `example.com.` | `example.com` |
| `blog.example.com` | `blog.example.com` |
| absent, or not a hostname | the Worker's own hostname |

One endpoint serves any number of sites. They separate by `site_id`, with no
configuration.

### Visitor identity

```
visitor_hash = SHA-256(ip | user-agent | site_id | date | salt), first 16 hex characters
```

- `date` is UTC, so the hash rotates at 00:00 UTC.
- `salt` is generated on the first request and stored in `meta.hash_salt`.
- `site_id` is part of the input, so the same client on two sites produces two unrelated
  hashes.

### Schema

Two tables, defined in `worker/migrations/` (`0001_init.sql`, then `0002_request_context.sql`
adds `in_app`, `city`, `lang` and `dc`, `0003_asn.sql` adds `asn` and `0004_tz_colo_rtt.sql`
adds `tz`, `colo` and `rtt`). One index:
`idx_events_site_created (site_id, created_at)`. `meta` holds a single row, `hash_salt`.

`events`:

| Column | |
|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `site_id` | normalised page hostname |
| `visitor_hash` | above |
| `event_name` | `page_view`, `click`, `form_submit`, or your own |
| `page_path` | path and query, sensitive parameters replaced with `REDACTED` |
| `referrer` | host and path, no query. Null for same-site referrers |
| `country` | `CF-IPCountry` |
| `browser`, `os`, `device` | parsed from the user agent. `browser` holds the bot name when `is_bot = 1`, `os` and `device` are null |
| `is_bot` | `0` or `1` |
| `privacy_mode` | always `1`, the daily-rotating hash |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` | parsed from the query string |
| `event_data` | JSON of `b`. Null for `page_view` |
| `created_at` | `datetime('now')`, UTC |
| `in_app` | the app whose in-app browser opened the page (`whatsapp`, `instagram`, `facebook`, `messenger`, `tiktok`, `linkedin`, `line`, `snapchat`, ...), from user agent tokens. Null for a normal browser. The user agent itself is never stored |
| `city` | Cloudflare's `request.cf.city` |
| `lang` | primary subtag of the first `Accept-Language` entry, lowercase (`pl`). Null when the header is missing |
| `dc` | `1` when the request came from a cloud or hosting network (a short ASN list, see `worker/src/ingest-context.ts`), `0` when not, null when Cloudflare gave no network data |
| `asn` | Cloudflare's `request.cf.asn`, the network's number, so `dc` can be recomputed later |
| `tz` | the browser's time zone as the script reports it (`Europe/Warsaw`). Null when absent or not a zone name |
| `colo` | Cloudflare's `request.cf.colo`, the data center that took the request (`WAW`) |
| `rtt` | Cloudflare's `request.cf.clientTcpRtt` in ms, rounded to 10. Null when there is none, which is common on HTTP/3 |

### Querying

```sql
SELECT date(created_at) AS day, COUNT(*) AS views
FROM events
WHERE site_id = 'example.com'
  AND event_name = 'page_view' AND is_bot = 0
  AND created_at >= datetime('now', '-30 days')
GROUP BY day ORDER BY day;
```

- `COUNT(DISTINCT visitor_hash)` is exact within one UTC day. Across several days it
  counts visitor-days.
- There is no session column, and no sessionisation at write time.
- Cloudflare's free plan allows 5,000,000 rows read and 100,000 rows written per day.
  Exceeding either blocks every D1 query on the account until 00:00 UTC, **including the
  insert on `/t`**. Filter on `created_at`.
- 100,000 rows written is about 23,000 pageviews a day with the index above.


## Payload

One `POST` per event, to `/t`:

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

| Key | | |
|---|---|---|
| `e` | event name | always |
| `p` | path and query | always |
| `d` | hostname the page was served from | always |
| `r` | referrer | always |
| `c` | consent state | omitted when no consent command was observed |
| `w` | `1`: `navigator.webdriver` was true, the browser is driven by a script | omitted otherwise |
| `z` | the browser's time zone, `Intl.DateTimeFormat().resolvedOptions().timeZone` | omitted when the browser gives none |
| `b` | event parameters | omitted when the event has none, so never on `page_view` |

Sent with `navigator.sendBeacon`, falling back to `fetch` with `keepalive: true`.

## dataLayer and Consent Mode

Objects pushed to `dataLayer` with an `event` key are sent under that name, with the
whole object as `b`. `gtag('event', name, params)` sends `params` the same way.

```js
window.dataLayer = window.dataLayer || [];
dataLayer.push({ event: 'purchase', value: 49, currency: 'USD' });
```

Events namespaced `gtm.*` are ignored; that prefix is GTM's own bookkeeping.

Consent is read from Consent Mode v2 commands on the same `dataLayer`:

```js
gtag('consent', 'default', { analytics_storage: 'denied' });
gtag('consent', 'update',  { analytics_storage: 'granted' });
```

Both the `Arguments` form `gtag()` produces and plain arrays are handled. Only values of
exactly `granted` or `denied` are recorded, which drops the non-signal keys a consent
command can carry, such as `wait_for_update` and `region`.

otag reads the state and passes it to the raw events as `c`. It acts on none of it, and
a CMP that never pushes a consent command leaves consent unset rather than denied.

## Develop

```bash
npm install
npm run build      # dist/otag.js, minified, prints raw/gzip/brotli sizes
npm run dev        # unminified, does not touch worker/src/otag.generated.ts
npm run typecheck
npm test           # builds, then runs test/smoke.mjs against a DOM stub
npm run check:generated

npm run build && open test-site/index.html    # no server; renders each payload
npm run test-site:dev                        # or serve it with wrangler
npm run test-site:deploy                     # deploys it as "otag-test-site"
```

`npm run build` also writes `worker/src/otag.generated.ts`, the script as a string: a
Worker cannot read a file at runtime, and Cloudflare builds `worker/` as a self-contained
directory. It is committed, and `npm run check:generated` fails if it has drifted.

The Worker against a local D1:

```bash
cd worker
npm install
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the script works and why.
