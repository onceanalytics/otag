# otag

The browser script behind [Once Analytics](https://onceanalytics.com). This is the
only part that runs on your website.

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
anonymous per-request identifier, a daily-rotating hash of IP and user agent, a
stable hash, or a first-party cookie.

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

otag does not implement those lists, and is not trying to. The rule is narrower:
whatever it does send uses GA4's name for it rather than a synonym of our own.
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

## Try it

```bash
npm run build
open test-site/index.html
```

No server needed. The page intercepts the requests and renders each payload:
click things, submit the form, push to `dataLayer`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full detail.
