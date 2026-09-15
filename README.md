# otag

The browser script behind [Once Analytics](https://onceanalytics.com). This is the
only part that runs on your website.

About 1.2KB over the wire. MIT licensed.

## What it sends

One POST per event, to your own endpoint, with short keys:

```json
{
  "e": "page_view",
  "p": "/pricing",
  "hn": "yoursite.com",
  "r": "https://news.ycombinator.com/",
  "c": { "analytics_storage": "granted" }
}
```

| Key | |
|---|---|
| `e` | event name |
| `p` | path and query |
| `hn` | hostname |
| `r` | referrer, on every event |
| `c` | consent state, omitted entirely when no consent command was seen |
| `i` `x` `h` `t` | element id, text, href, tag - on interactions |
| `dl` | event properties, for dataLayer events |

That is the whole payload, and the only request the script makes.

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
| `form_submit` | form submissions |
| `error` | uncaught errors and unhandled promise rejections |
| `web_vitals` | once, when the page is hidden - LCP, CLS and INP. Sampled at 25% |
| *your own* | anything pushed to `dataLayer`, and `gtag('event', …)` |

Text captured from an element is sent as-is, truncated at 50 characters. Redaction
happens server-side.

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
