# Architecture

otag is a single IIFE with no dependencies. It takes no configuration, has no
build variants, and requests no host other than the endpoint derived from its
own script URL.

## Lifecycle

1. Reads its own `<script>` element. The endpoint is that URL's origin plus `/t`.
2. Installs itself in front of `window.dataLayer`, replaying anything already
   queued and proxying every later `push` - the original `push` still runs. This
   happens **before** the first `page_view`, so consent defaults already on the
   queue apply to it.
3. Sends `page_view`, or, on a page Chrome is prerendering, queues it and
   everything else until `prerenderingchange`.
4. Wraps `history.pushState` / `replaceState` and listens for `popstate`.
5. Listens for clicks, form focus and submits, errors and unhandled
   rejections.
6. Listens, once, for the first trusted input, and sends `engaged`.
7. Observes `largest-contentful-paint`, `layout-shift` and `event`, accumulating
   Web Vitals for a single report when the page is hidden.

## Wire format

Two tiers, and only two.

The **envelope** - `e`, `p`, `d`, `r`, `c` - is how the request is routed. All of
it is needed before the event name means anything: `d` selects the site, `c`
decides which identity mode applies. It keeps short keys because it is transport,
not data. `w` rides with it from 0.3.1: `1` when `navigator.webdriver` was
true. Like `c` it is a fact about the sender, and the worker decides what it
means (a bot). `z` joins them in 0.3.2: the browser's time zone, read once per
page load. The request tells the worker where the network is; this is where the
device's clock is set, and a zone far from the country is the cheapest proxy
signal there is. The worker stores it only when it looks like an IANA name.

**`b`** is what happened, under GA4's parameter names, spelled out. A click's
`link_url` and a pushed `purchase`'s `value` arrive the same way and are stored
the same way, because they are the same kind of thing: which of them counts as a
conversion is a reporting decision made later, against everything already
collected.

Before 0.3 there was a third tier - `i`, `x`, `h`, `t` alongside the envelope for
interactions, `dl` for everything else - which cost a key that meant element text
on `click` and the form's name on `form_submit`. Collapsing it removed that
ambiguity, removed the tag name nothing read, and removed the branch in the
worker that chose between the two shapes. It costs about 20 bytes on an
interaction beacon and nothing on a page view.

## Where otag differs from GA4

Event and parameter names follow GA4's, so the differences are worth stating rather
than discovering.

`p` and `d` are GA4's `page_location` split in two and `r` is `page_referrer`; the
envelope keeps short keys because it is transport, not data.

- **`click` fires on any interactive element**, where GA4's fires only on outbound
  links. Which clicks matter is a server decision here, and a broad capture can still
  be narrowed later.
- **`form_start` is once per form per page load**, where GA4 counts it once per form
  per *session*. The script has no session, so the server collapses them.
- **`web_vitals` has no GA4 equivalent.** Google's own web-vitals library sends one
  event per metric; otag sends one report per page.
- **`exception` carries `description`, `source` and `stack`**, and not GA4's `fatal`.
  Neither an uncaught error nor a rejected promise stops a page, so it would be a
  constant `false` on every event.
- **No element tag name on `click`.** GA4 has no parameter for one and no report read
  it.

A new event takes its name from GA4's [enhanced measurement](https://support.google.com/analytics/answer/9216061?hl=en)
or [recommended events](https://support.google.com/analytics/answer/9267735?hl=en)
list if either has one for it, and a plain snake_case name that collides with neither
if they do not.

## Transport

`navigator.sendBeacon`, falling back to `fetch` with `keepalive: true` and
`credentials: "include"` so a first-party cookie mode still works. The fallback
also covers `sendBeacon` *returning false* - which it does when the queue is full
or the payload is too large - so a refused beacon is retried rather than silently
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
Enforcement - dropping ad identifiers, choosing the privacy mode, deciding what
to persist - happens server-side.

A rule implemented in the script would be deployed across every site and could
only apply to data collected after the update. The same rule on the server is a
single change and applies to data already collected.

## Interaction capture

Clicks walk up from the event target collecting the first `id`, and are sent
when a control (a link, button, form field, `<summary>`, or an ARIA button,
link, tab or menu item) or an element with an id was found. From 0.3.2:

- `link_text` is a control's own label: the first text from the target up to
  the control, capped at 50 characters. A click that hit no control (a swipe
  in `section#galeria`) sends the id alone; the text there is whatever content
  was under the pointer.
- A form field sends its id alone: an `<input>`, `<select>`, `<textarea>`,
  `<label>`, an ARIA text box, combo box or list box, an editable area, or a
  control holding one. A `<select>`'s text is every option it offers, and the
  text around an input is its label and help text.
- `link_url` is the anchor's `href` without its query string or `#fragment`.
  The worker cuts it the same way before storing (`storedEventData` in
  worker/src/ingest-context.ts), so pages running an older cached script are
  covered too.

The listener is registered in the **capture** phase, so a handler calling
`stopPropagation()` - routine in consent banners and SPA frameworks - cannot
hide the click. One consequence follows from that: a click that *causes* a
consent command runs before the command is processed, so the click on a CMP's
own accept button carries no consent state. That is accurate rather than a
defect; consent had not been given at the moment of the click.

Captured text is otherwise sent verbatim. Redaction is server-side, for the same
reason as consent enforcement. The form field and link address rules above are
the exception: what never leaves the page cannot leak.

Which interactions matter is not decided here. Conversions are defined
server-side against this captured data, so a rule written today also applies to
everything already collected. There is no client-side trigger system.

## Forms

`form_start` and `form_submit`, GA4's pair, both carrying the form's id, name and
action so they describe the same form.

`form_start` fires on the first `focusin` inside a form, once per form per page
load. Focus rather than input, because a form the visitor tabbed into and
abandoned is exactly the one worth knowing about - waiting for a keystroke would
lose every abandonment before the first character. The cost is an autofocused
field, which starts a form nobody touched; GA4's own implementation has the same
edge.

Once per *page load* rather than GA4's once per session: the script has no
session - that is a server concept here, reconstructed from the event stream -
so it bounds what it can see and the server collapses the rest. A visitor who
starts a form, navigates away and comes back sends two.

## Core Web Vitals

Accumulated during the page's life and reported **once**, on the first
`visibilitychange` to `hidden`. Reporting per observer callback would be both
noisy - three or more extra requests per page view - and wrong, because neither
CLS nor INP means anything until the page is finished:

- **LCP** - the latest `largest-contentful-paint` entry's `startTime`.
- **CLS** - the running sum of `layout-shift` values, excluding shifts the
  browser flagged `hadRecentInput`, which are excluded by definition. This is the
  simple cumulative sum, not the session-window refinement of the current spec.
- **INP** - the largest `duration` among `event` entries that carry an
  `interactionId`. Entries without one are not interactions.

If none of the three were ever observed, nothing is sent. The report fires at
most once per page, so a hide/show/hide cycle does not duplicate it.

## Engaged

One `engaged` event per page load, at the first trusted `pointerdown`,
`touchstart`, `scroll`, `keydown`, or `pointermove` with `pointerType` `mouse`
(a pen or finger hovering is not a mouse). Capture and passive listeners on
`window`, removed once it fires. `b.t` is the delay in ms, `b.k` one letter for
the input (`p`, `t`, `s`, `k`, `m`).

- **Trusted only.** An event a page script dispatches has `isTrusted` false and
  is ignored. Input a browser driver injects (Puppeteer's `page.mouse`) is
  trusted, so this is a fact about the page, not proof of a person. A scroll the
  browser makes itself (restoring a position, jumping to `#anchor`) is trusted
  too and arrives as `k: "s"` with a small `t`; telling those apart is a
  reporting decision.
- **Not sampled**, unlike Web Vitals: one small request, and only on pages
  someone touched.
- **No storage.** It is per page load, so an SPA route change does not send
  another, and a reload does.
- **The clock starts when the page is first visible**, not when the script ran.
  A tab opened in the background, or a prerender, can sit for minutes before
  anyone looks at it, and that wait says nothing about the visitor. Measured
  from script start it would make every background tab look like a slow
  reader. Hiding and showing the page again does not restart it.

What it means (a person, a bot that scrolls) is decided by Once Analytics, at
read time.

## Prerendering

Chrome's speculation rules can load a page before the visitor clicks, and throw
it away if they never do. otag checks `document.prerendering` in `send`: while it
is true every event is queued, in order, and the queue goes out on
`prerenderingchange`. A prerender that is never shown sends nothing, so it is
not a page view.

A page loaded in a **background tab** is different: someone asked for it, so
its `page_view` goes at once. Only the engaged clock waits for it to be shown.

## What the script decides, and why

The script reports; the server stores and interprets. A handful of decisions are
made here anyway, and they are all the same kind: bounding volume that would
otherwise be unbounded. None of them filter by *content*.

- **Page views on path change only.** SPAs call `replaceState` continuously for
  filter state and scroll position. Reporting each one would be hundreds of
  requests per page. The cost is that a query-only change is invisible.
- **Clicks only when a control or an id is found**, and element text capped
  at 50 characters and taken from the control only. Without the first, every
  click anywhere on the page is an event; without the second, a click near the
  top of the tree sends the page.
- **`gtm.*` ignored.** GTM's own bookkeeping fires several times per page load
  and is never a site event.
- **`href` read from anchors only.**
- **`form_start` once per form per page load.** Every focus into a form would
  otherwise be an event, and a visitor moving between three fields would start
  the same form three times.
- **Web Vitals accumulated, reported once, and sampled at 25%.** They fire once
  per page view whatever the visitor does, so they are the largest single share
  of traffic - around 40% of the requests a typical visit makes. The decision is
  taken before any observer is created, so an unsampled page costs nothing at
  runtime either, and the rate travels with the event so a report
  can say what it estimated from as `b.rate`. Unlike most of what the server decides, an
  unsent sample cannot be recovered later, which is why the rate is set
  generously rather than at the 1% a large site would use.
- **Stack traces cut at 1000 characters.**

Anything that filters by content - consent enforcement, ad-identifier handling,
redaction, which interactions count as conversions - belongs on the server, where
one change applies to every site and to data already collected.

## dataLayer

Plain objects with an `event` key are sent with the whole object as `b`, and
`gtag('event', name, params)` sends its params the same way. A site that already
names its events as GA4 does therefore needs to change nothing, and its
parameters sit beside otag's own under the same rules.

Any event namespaced `gtm.*` is ignored - that prefix is GTM's own bookkeeping,
never a site event. Matching the namespace rather than a fixed list means GTM
internals added in future are ignored too, without a tracker release.

## Tests

`npm test` builds, then runs `test/smoke.mjs` - the built artifact against a
minimal DOM stub under `node:vm`. It covers the wire format, that no identity is
ever sent, consent default/update semantics, that the query string and captured text are
passed through untouched, the SPA path guard, click capture, the form_start /
form_submit pair and its once-per-form guard, exception reporting, dataLayer
pass-through, the Web Vitals accumulation rules above, the time zone, the
engaged event (trusted inputs only, once, the clock from first visible) and the
prerender queue. `test/ingest.mjs` runs the worker's `handleTrack` against a
fake D1: real `request.cf` shapes with and without `clientTcpRtt`, time zone
names and junk, and a 0.3.1 payload.

It is not a browser test. Real-browser coverage belongs in Playwright alongside
it.

## Build

`build.js` produces one esbuild IIFE bundle targeting ES2018. There are no flags
or variants; every install gets the same script. `npm run build` prints raw, gzip
and brotli sizes. Brotli is what Cloudflare serves.
