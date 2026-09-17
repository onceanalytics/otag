// otag - the Once Analytics browser script.
//
// Sends to {script origin}/t. Deliberately thin: it observes and reports, and
// makes no policy decisions. Identity, consent enforcement, ad-identifier
// handling and redaction all happen server-side, on infrastructure the site
// owner controls - one place to change a rule, and changes apply to data
// already collected.

(function () {
  const d = document;
  const w = window as any;
  const n = navigator;
  const s = d.currentScript as HTMLScriptElement;
  if (!s) return;

  const endpoint = new URL(s.src).origin + "/t";
  const referrer = d.referrer;

  // ── Consent ──
  // No defaults. If the site's CMP never pushes a consent command, consent is
  // unset rather than denied. The worker decides what to do with it.
  const consent: Record<string, string> = {};
  let sawConsent = false;

  function updateConsent(obj: Record<string, unknown>) {
    for (const k in obj) {
      if (obj[k] === "granted" || obj[k] === "denied") {
        consent[k] = obj[k] as string;
        sawConsent = true;
      }
    }
  }

  // ── Send ──
  // Two tiers, and only two. The envelope - e, p, d, r, c - is how the request
  // is routed: the server needs all of it before it knows what the event is,
  // because d picks the site and c decides the identity. b is what happened,
  // under GA4's parameter names.
  function send(e: string, b?: Record<string, unknown>) {
    const o: Record<string, unknown> = { e, p: location.pathname + location.search, d: location.hostname };
    // Sent on every event. It is constant for the page load, and deciding which
    // event should carry it is a server decision, not one to bake into a script
    // deployed across every site.
    if (referrer) o.r = referrer;
    if (sawConsent) o.c = consent;
    if (b) o.b = b;
    const body = JSON.stringify(o);
    // sendBeacon returns false when it refuses the payload (queue full, too
    // large). Falling through on false is what stops the event being dropped.
    if (!n.sendBeacon || !n.sendBeacon(endpoint, body)) {
      fetch(endpoint, { method: "POST", keepalive: true, credentials: "include", body });
    }
  }

  // ── dataLayer ──
  // Installed before the first page_view so consent defaults already queued are
  // applied to it.
  // Anything namespaced gtm.* is GTM's own bookkeeping, not a site event.
  const GTM_INTERNAL = /^gtm\./;

  function isArrayLike(x: any): boolean {
    return Array.isArray(x) || (typeof x === "object" && x !== null && typeof x.length === "number");
  }

  function processItem(item: any) {
    if (!item) return;

    // gtag('consent', 'default'|'update', {...}) and gtag('event', name, params)
    if (isArrayLike(item)) {
      if (item[0] === "consent" && item.length >= 3) {
        if ((item[1] === "default" || item[1] === "update") && item[2] && typeof item[2] === "object") {
          updateConsent(item[2]);
        }
      } else if (item[0] === "event" && typeof item[1] === "string") {
        send(item[1], item[2]);
      }
      return;
    }

    if (typeof item === "object" && typeof item.event === "string" && !GTM_INTERNAL.test(item.event)) {
      send(item.event, item);
    }
  }

  w.dataLayer = w.dataLayer || [];
  for (const item of w.dataLayer) processItem(item);

  const origPush = w.dataLayer.push.bind(w.dataLayer);
  w.dataLayer.push = function (...args: unknown[]) {
    for (const a of args) processItem(a);
    return origPush(...args);
  };

  // ── Page view ──
  send("page_view");

  // ── SPA: only when the path actually changes ──
  // replaceState fires constantly in SPAs for filters and scroll restoration;
  // counting those as page views would inflate every number in the product.
  let curPath = location.pathname;

  function nav() {
    if (location.pathname !== curPath) {
      curPath = location.pathname;
      send("page_view");
    }
  }

  const hp = history.pushState;
  const hr = history.replaceState;
  history.pushState = function (...a: any[]) {
    const r = hp.apply(this, a as any);
    nav();
    return r;
  };
  history.replaceState = function (...a: any[]) {
    const r = hr.apply(this, a as any);
    nav();
    return r;
  };
  w.addEventListener("popstate", nav);

  // ── Clicks on interactive elements ──
  // GA4 fires click on outbound links only; this one fires on any interactive
  // element, because which clicks matter is decided server-side here and a
  // capture that is too broad can still be narrowed later. The parameters are
  // GA4's all the same. No tag name is sent: GA4 has no parameter for one, and
  // no report ever read it.
  d.addEventListener("click", function (ev: Event) {
    let el = ev.target as any;
    const o: Record<string, unknown> = {};
    let interactive = false;

    while (el && el !== d) {
      if (!o.link_id && el.id) o.link_id = el.id;
      if (!o.link_text && el.textContent) {
        // Truncate rather than drop. Dropping meant a button whose label ran
        // past the limit produced no link_text at all, and with no id or href
        // the whole click was then discarded by the check below.
        const t = el.textContent.trim();
        if (t) o.link_text = t.length > 50 ? t.slice(0, 50) : t;
      }
      const tn = el.tagName;
      if (!interactive && (tn === "A" || tn === "BUTTON" || tn === "INPUT" || el.getAttribute?.("role") === "button")) {
        interactive = true;
        if (tn === "A") o.link_url = el.getAttribute("href");
      }
      if (o.link_id) interactive = true;
      if (o.link_id && o.link_url) break;
      el = el.parentNode;
    }

    if (interactive && (o.link_id || o.link_url || o.link_text)) send("click", o);
  }, true);

  // ── Forms ──
  // GA4's pair: form_start on the first interaction with a form, form_submit on
  // submit. Both carry the same three identifiers, so they describe one form.
  const started = new WeakSet<object>();

  function formData(f: any) {
    const o: Record<string, unknown> = {};
    if (f.id) o.form_id = f.id;
    if (f.name) o.form_name = String(f.name);
    if (f.getAttribute("action")) o.form_destination = f.getAttribute("action");
    return o;
  }

  // GA4 counts form_start once per form per session. The script has no session -
  // that is a server concept here - so it bounds what it can see: once per form
  // per page load, and the server collapses the rest.
  // focusin rather than input, because a form the visitor tabbed into and
  // abandoned is exactly the one worth knowing about. An autofocused field
  // therefore starts a form nobody touched; GA4 has the same edge.
  d.addEventListener("focusin", function (ev: Event) {
    let el = ev.target as any;
    while (el && el !== d) {
      if (el.tagName === "FORM") {
        if (!started.has(el)) {
          started.add(el);
          send("form_start", formData(el));
        }
        return;
      }
      el = el.parentNode;
    }
  }, true);

  d.addEventListener("submit", function (ev: Event) {
    const f = ev.target as any;
    if (!f || f.tagName !== "FORM") return;
    send("form_submit", formData(f));
  }, true);

  // ── JS errors ──
  // GA4 calls this exception, and the message parameter description. `fatal` is
  // the third parameter it defines, and is not sent: neither an uncaught error
  // nor a rejected promise stops a page, so the answer would be a constant false
  // on every event.
  w.addEventListener("error", function (e: ErrorEvent) {
    send("exception", { description: e.message, source: e.filename, stack: e.error?.stack?.slice(0, 1000) });
  });

  w.addEventListener("unhandledrejection", function (e: PromiseRejectionEvent) {
    send("exception", { description: String(e.reason).slice(0, 1000) });
  });

  // ── Core Web Vitals ──
  // Accumulated, then reported once when the page is hidden. Reporting per
  // observer callback would be both noisy (3+ requests per page view) and
  // wrong: CLS is cumulative and INP is the worst interaction, so neither
  // means anything until the page is done.
  // Vitals fire once per page view regardless of interaction, so they are the
  // largest single share of traffic. Sampling bounds that; it does not filter by
  // content. The decision is made once, before any observer is created, so an
  // unsampled page costs nothing at runtime either.
  //
  // Unsent samples cannot be recovered later, unlike most of what the server
  // decides, so this is set generously. The rate travels with the event so a
  // report can say what it was estimated from.
  const VITALS_SAMPLE = 0.25;

  if (typeof PerformanceObserver !== "undefined" && Math.random() < VITALS_SAMPLE) {
    let lcp = 0;
    let cls = 0;
    let inp = 0;
    let seen = false;

    const observe = function (type: string, take: (e: any) => void) {
      try {
        new PerformanceObserver(function (list) {
          for (const e of list.getEntries()) take(e);
        }).observe({ type, buffered: true });
      } catch {}
    };

    observe("largest-contentful-paint", function (e) {
      lcp = e.startTime;
      seen = true;
    });

    // Shifts within 500ms of an interaction are excluded by definition -
    // the browser flags them with hadRecentInput.
    observe("layout-shift", function (e) {
      if (!e.hadRecentInput) {
        cls += e.value;
        seen = true;
      }
    });

    observe("event", function (e) {
      if (e.interactionId && e.duration > inp) {
        inp = e.duration;
        seen = true;
      }
    });

    let reported = false;
    d.addEventListener("visibilitychange", function () {
      if (d.visibilityState === "hidden" && !reported && seen) {
        reported = true;
        send("web_vitals", {
          lcp: Math.round(lcp),
          cls: Math.round(cls * 1000) / 1000,
          inp: Math.round(inp),
          rate: VITALS_SAMPLE,
        });
      }
    });
  }
})();
