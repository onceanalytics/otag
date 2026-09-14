# otag

The browser script behind [Once Analytics](https://onceanalytics.com). This is the
only part that runs on your website, so it's the only part you need to read.

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
| `r` | referrer — first event only |
| `c` | consent state, omitted entirely when no consent command was seen |
| `i` `x` `h` `t` | element id, text, href, tag — on interactions |
| `dl` | event properties, for dataLayer events |

That is the whole payload. There is no other request, to anywhere.

The script makes no policy decisions. It reports what it observed — including the
consent state — and your server decides what to keep, what to drop and how to
identify visitors. One place to change a rule, and a change applies to data
already collected rather than only to sites that have redeployed the script.

## What it stores

**Nothing.** No cookies, no `localStorage`, no `sessionStorage`. The script has no
identity of its own and never reads or writes browser storage.

Visitors are identified on your server, under a privacy mode you choose — from a
fully anonymous per-request identifier, through a daily-rotating hash of IP and
user agent, to a first-party cookie if you want one. The script doesn't know or
care which; it just reports the consent state it observed.

No fingerprinting, no canvas, no device enumeration.

## What it collects

| Event | When |
|---|---|
| `page_view` | page load, and when an SPA changes path |
| `click` | clicks on links, buttons, inputs and `role="button"` |
| `form_submit` | form submissions |
| `error` | uncaught errors and unhandled promise rejections |
| `web_vitals` | once, when the page is hidden — LCP, CLS and INP |
| *your own* | anything pushed to `dataLayer`, and `gtag('event', …)` |

Text captured from an element is sent as-is, up to 50 characters. Redaction
happens server-side, where the rules can be changed without redeploying the
script to every site.

## Install

```html
<script src="https://your-worker.example.com/script.js" defer></script>
```

Nothing to configure. The endpoint is the script's own origin plus `/t`, so
the served bytes are identical for every site.

## Consent

otag understands Google Consent Mode v2 and assumes nothing. If your CMP never
pushes a consent command, consent is *unset* rather than denied.

Whatever it observes is reported on every event as `c`. Your server enforces it —
choosing the privacy mode for that request and deciding what to store. Because
the endpoint is your own infrastructure, nothing reaches a third party either
way.

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

No server needed. The page swallows the requests and renders each payload as it
happens — click things, submit the form, push to `dataLayer`, and watch what
would have been sent.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full detail.
