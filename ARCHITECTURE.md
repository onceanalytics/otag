# Architecture

otag is a single IIFE. No dependencies, no configuration, no build variants, and
no request to any host other than the endpoint it derives from its own URL.

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
identifier. Who a visitor is gets decided on the server, per the site's privacy
mode.

This is deliberate. A client-side `sessionStorage` identifier dies with the tab,
so every new tab would read as a new visitor and every unique count in the
product would be inflated.

## SPA page views

A page view is sent only when `location.pathname` actually changes. SPAs call
`replaceState` constantly for filter state and scroll restoration; counting those
would inflate every number in the product.

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

That is deliberate. A rule implemented in the script is deployed across every
customer site and can only ever apply to future data; the same rule on the server
is one change, applies immediately, and applies to everything already collected.
Since the endpoint is the site owner's own infrastructure, no third party is
involved either way.

## Interaction capture

Clicks walk up from the event target collecting `id`, trimmed text under 50
characters, `href` and tag name, and are sent only when an interactive ancestor
was found. Form submits send the form's id, name and action.

Captured text is sent verbatim. Redaction is server-side, for the same reason as
consent enforcement.

Nothing about which interactions *matter* lives here. Conversions are defined
server-side against this captured data, which means a rule written today also
applies to everything already collected. That is why there is no client-side
trigger system.

## Core Web Vitals

Accumulated during the page's life and reported **once**, on the first
`visibilitychange` to `hidden`. Reporting per observer callback would be both
noisy — three or more extra requests per page view — and wrong, because neither
CLS nor INP means anything until the page is finished:

- **LCP** — the latest `largest-contentful-paint` entry's `startTime`.
- **CLS** — the running sum of `layout-shift` values, excluding shifts the
  browser flagged `hadRecentInput`, which are excluded by definition. This is the
  simple cumulative sum, not the session-window refinement of the current spec;
  for a script this size that tradeoff is deliberate.
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

It is deliberately not a browser test. It is the fast guard that runs on every
build; real-browser coverage belongs in Playwright alongside it.

## Build

`build.js` produces one esbuild IIFE bundle targeting ES2018. No flags, no
variants — every install gets the same script. `npm run build` prints raw, gzip
and brotli sizes; brotli is what Cloudflare serves.
