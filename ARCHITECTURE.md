# Architecture

otag is a single IIFE with no dependencies. It takes no configuration, has no
build variants, and requests no host other than the endpoint derived from its
own script URL.

## Lifecycle

1. Reads its own `<script>` element. The endpoint is that URL's origin plus `/t`.
2. Installs itself in front of `window.dataLayer`, replaying anything already
   queued and proxying every later `push` — the original `push` still runs. This
   happens **before** the first `page_view`, so consent defaults already on the
   queue apply to it.
3. Sends `page_view`.
4. Wraps `history.pushState` / `replaceState` and listens for `popstate`.
5. Listens for clicks, form submits, errors and unhandled rejections.
6. Observes `largest-contentful-paint`, `layout-shift` and `event`, accumulating
   Web Vitals for a single report when the page is hidden.

## Transport

`navigator.sendBeacon`, falling back to `fetch` with `keepalive: true` and
`credentials: "include"` so a first-party cookie mode still works. The fallback
also covers `sendBeacon` *returning false* — which it does when the queue is full
or the payload is too large — so a refused beacon is retried rather than silently
dropped. Both are
fire-and-forget: otag never reads a response and never retries, so a failing
endpoint cannot slow down or break the page.

The body is a JSON string sent without a `Content-Type` header, which keeps it a
CORS-simple request and avoids a preflight on every event.

## Identity

The script has none. It writes nothing to browser storage and sends no
identifier; the server decides, per the site's privacy mode.

A client-side `sessionStorage` identifier would die with the tab, making every
new tab a new visitor and inflating unique counts.

## SPA page views

A page view is sent only when `location.pathname` changes. SPAs call
`replaceState` frequently for filter state and scroll restoration, which would
otherwise be counted as page views.

## Consent Mode v2

Consent is populated only from commands observed on the dataLayer:

```js
gtag('consent', 'default', { analytics_storage: 'denied' });
gtag('consent', 'update',  { analytics_storage: 'granted' });
```

Both the Arguments form `gtag()` produces and plain arrays are handled. Only
values of exactly `granted` or `denied` are recorded, which filters out the
non-signal keys a consent command may also carry (`wait_for_update`, `region`).

The observed state travels as `c` on every event. The script acts on none of it.
Enforcement — dropping ad identifiers, choosing the privacy mode, deciding what
to persist — happens server-side.

A rule implemented in the script would be deployed across every site and could
only apply to data collected after the update. The same rule on the server is a
single change and applies to data already collected.

## Interaction capture

Clicks walk up from the event target collecting `id`, trimmed text under 50
characters, `href` and tag name, and are sent only when an interactive ancestor
was found. Form submits send the form's id, name and action.

Captured text is sent verbatim. Redaction is server-side, for the same reason as
consent enforcement.

Which interactions matter is not decided here. Conversions are defined
server-side against this captured data, so a rule written today also applies to
everything already collected. There is no client-side trigger system.

## Core Web Vitals

Accumulated during the page's life and reported **once**, on the first
`visibilitychange` to `hidden`. Reporting per observer callback would be both
noisy — three or more extra requests per page view — and wrong, because neither
CLS nor INP means anything until the page is finished:

- **LCP** — the latest `largest-contentful-paint` entry's `startTime`.
- **CLS** — the running sum of `layout-shift` values, excluding shifts the
  browser flagged `hadRecentInput`, which are excluded by definition. This is the
  simple cumulative sum, not the session-window refinement of the current spec.
- **INP** — the largest `duration` among `event` entries that carry an
  `interactionId`. Entries without one are not interactions.

If none of the three were ever observed, nothing is sent. The report fires at
most once per page, so a hide/show/hide cycle does not duplicate it.

## dataLayer

Plain objects with an `event` key are sent with the whole object as `dl`.
`gtag('event', name, params)` is sent the same way.

Any event namespaced `gtm.*` is ignored — that prefix is GTM's own bookkeeping,
never a site event. Matching the namespace rather than a fixed list means GTM
internals added in future are ignored too, without a tracker release.

## Tests

`npm test` builds, then runs `test/smoke.mjs` — the built artifact against a
minimal DOM stub under `node:vm`. It covers the wire format, that no identity is
ever sent, consent default/update semantics, that the query string and captured text are
passed through untouched, the SPA path guard, click and form capture, dataLayer
pass-through, and the Web Vitals accumulation rules above.

It is not a browser test. Real-browser coverage belongs in Playwright alongside
it.

## Build

`build.js` produces one esbuild IIFE bundle targeting ES2018. There are no flags
or variants; every install gets the same script. `npm run build` prints raw, gzip
and brotli sizes. Brotli is what Cloudflare serves.
