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
  function send(e: string, data?: Record<string, unknown>) {
    const o: Record<string, unknown> = data || {};
    o.e = e;
    o.p = location.pathname + location.search;
    o.hn = location.hostname;
    // Sent on every event. It is constant for the page load, and deciding which
    // event should carry it is a server decision, not one to bake into a script
    // deployed across every site.
    if (referrer) o.r = referrer;
    if (sawConsent) o.c = consent;
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
        send(item[1], item[2] ? { dl: item[2] } : undefined);
      }
      return;
    }

    if (typeof item === "object" && typeof item.event === "string" && !GTM_INTERNAL.test(item.event)) {
      send(item.event, { dl: item });
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
  d.addEventListener("click", function (ev: Event) {
    let el = ev.target as any;
    const o: Record<string, unknown> = {};
    let interactive = false;
    let tag: string | null = null;

    while (el && el !== d) {
      if (!o.i && el.id) o.i = el.id;
      if (!o.x && el.textContent) {
        // Truncate rather than drop. Dropping meant a button whose label ran
        // past the limit produced no x at all, and with no id or href the whole
        // click was then discarded by the check below.
        const t = el.textContent.trim();
        if (t) o.x = t.length > 50 ? t.slice(0, 50) : t;
      }
      const tn = el.tagName;
      if (!interactive && (tn === "A" || tn === "BUTTON" || tn === "INPUT" || el.getAttribute?.("role") === "button")) {
        interactive = true;
        tag = tn;
        if (tn === "A") o.h = el.getAttribute("href");
      }
      if (o.i) interactive = true;
      if (o.i && o.h) break;
      el = el.parentNode;
    }

    if (interactive && (o.i || o.h || o.x)) {
      if (tag) o.t = tag;
      send("click", o);
    }
  }, true);

  // ── Form submissions ──
  d.addEventListener("submit", function (ev: Event) {
    const f = ev.target as any;
    if (!f || f.tagName !== "FORM") return;
    const o: Record<string, unknown> = {};
    if (f.id) o.i = f.id;
    if (f.name) o.x = String(f.name);
    if (f.getAttribute("action")) o.h = f.getAttribute("action");
    o.t = "FORM";
    send("form_submit", o);
  }, true);

  // ── JS errors ──
  w.addEventListener("error", function (e: ErrorEvent) {
    send("error", {
      dl: { message: e.message, source: e.filename, stack: e.error?.stack?.slice(0, 1000) },
    });
  });

  w.addEventListener("unhandledrejection", function (e: PromiseRejectionEvent) {
    send("error", { dl: { message: String(e.reason).slice(0, 1000) } });
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
          dl: {
            lcp: Math.round(lcp),
            cls: Math.round(cls * 1000) / 1000,
            inp: Math.round(inp),
            rate: VITALS_SAMPLE,
          },
        });
      }
    });
  }
})();
