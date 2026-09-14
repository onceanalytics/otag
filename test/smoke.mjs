// Runs the BUILT artifact against a minimal DOM stub under node:vm.
// Fast guard on every build; browser-level coverage belongs in Playwright.

import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const SCRIPT = readFileSync(new URL("../dist/otag.js", import.meta.url), "utf8");

function el(props = {}) {
  return {
    tagName: null, id: "", textContent: "", parentNode: null,
    getAttribute: (a) => props.attrs?.[a] ?? null,
    ...props,
  };
}

function run({ path = "/pricing", search = "", dataLayer = [] } = {}) {
  const sent = [];
  const handlers = { document: {}, window: {} };
  const noop = () => {};

  const location = {
    pathname: path, search, hostname: "site.test",
    get href() { return "https://site.test" + this.pathname + this.search; },
  };

  const observers = {};
  const doc = {
    currentScript: { dataset: {}, src: "https://w.test/script.js" },
    referrer: "https://news.ycombinator.com/",
    title: "Pricing",
    visibilityState: "visible",
    addEventListener: (t, fn) => (handlers.document[t] = fn),
  };

  class PerformanceObserverStub {
    constructor(cb) { this.cb = cb; }
    observe({ type }) { observers[type] = this.cb; }
  }

  const win = {
    dataLayer, location, document: doc,
    history: { pushState: noop, replaceState: noop },
    navigator: { sendBeacon: (_u, b) => (sent.push(JSON.parse(b)), true) },
    addEventListener: (t, fn) => (handlers.window[t] = fn),
    PerformanceObserver: PerformanceObserverStub,
    Math,
    URL, URLSearchParams, JSON, Object, Array, console, Buffer,
  };
  win.window = win;

  vm.createContext(win);
  vm.runInContext(SCRIPT, win);

  return {
    sent, win, location, handlers,
    click: (target) => handlers.document.click?.({ target }),
    submit: (target) => handlers.document.submit?.({ target }),
    goto: (p) => { location.pathname = p; win.history.pushState(); },
    emit: (type, entries) => observers[type]?.({ getEntries: () => entries }),
    hide: () => { doc.visibilityState = "hidden"; handlers.document.visibilitychange?.(); },
    show: () => { doc.visibilityState = "visible"; handlers.document.visibilitychange?.(); },
  };
}

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("wire format");

check("page_view uses the app's short keys", () => {
  const { sent } = run();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    { e: sent[0].e, p: sent[0].p, hn: sent[0].hn, r: sent[0].r },
    { e: "page_view", p: "/pricing", hn: "site.test", r: "https://news.ycombinator.com/" }
  );
});

check("no client-side identity is ever sent", () => {
  const { sent } = run();
  for (const k of ["visitor_id", "session_id", "url", "name", "title"])
    assert.equal(k in sent[0], false, `${k} must not be in the payload`);
});

check("referrer is sent once, not on later events", () => {
  const r = run();
  r.goto("/docs");
  assert.ok(r.sent[0].r, "first event carries referrer");
  assert.equal(r.sent[1].r, undefined, "second event must not");
});

console.log("consent");

check("unset consent is omitted", () => {
  assert.equal(run().sent[0].c, undefined);
});

check("consent default is applied to the first page_view", () => {
  const { sent } = run({ dataLayer: [["consent", "default", { analytics_storage: "denied" }]] });
  assert.equal(sent[0].c.analytics_storage, "denied");
});

check("update overrides default", () => {
  const { sent } = run({ dataLayer: [
    ["consent", "default", { analytics_storage: "denied" }],
    ["consent", "update", { analytics_storage: "granted" }],
  ]});
  assert.equal(sent[0].c.analytics_storage, "granted");
});

check("non-signal keys ignored", () => {
  const { sent } = run({ dataLayer: [
    ["consent", "default", { ad_storage: "denied", wait_for_update: 500, region: ["ES"] }],
  ]});
  assert.deepEqual(Object.keys(sent[0].c), ["ad_storage"]);
});

console.log("thin client");

check("query string is passed through untouched", () => {
  const { sent } = run({
    search: "?gclid=A&fbclid=B&id=42&utm_source=news",
    dataLayer: [["consent", "default", { ad_storage: "denied" }]],
  });
  assert.equal(sent[0].p, "/pricing?gclid=A&fbclid=B&id=42&utm_source=news",
    "the script must not rewrite the path — the server decides what to keep");
});

check("consent is still reported so the server can act on it", () => {
  const { sent } = run({
    search: "?gclid=A",
    dataLayer: [["consent", "default", { ad_storage: "denied" }]],
  });
  assert.equal(sent[0].c.ad_storage, "denied");
});

check("captured text is sent verbatim for the server to redact", () => {
  const r = run();
  r.click(el({ tagName: "BUTTON", id: "b", textContent: "Email michal@raczka.me" }));
  assert.equal(r.sent[1].x, "Email michal@raczka.me");
});

console.log("SPA");

check("replaceState on the same path does not count a page view", () => {
  const r = run();
  r.win.history.replaceState();
  r.win.history.replaceState();
  assert.equal(r.sent.length, 1, "only the initial page_view");
});

check("a real path change does", () => {
  const r = run();
  r.goto("/docs");
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].p, "/docs");
});

console.log("interactions");

check("click on a button is captured", () => {
  const r = run();
  r.click(el({ tagName: "BUTTON", id: "signup", textContent: "Sign up" }));
  const c = r.sent[1];
  assert.equal(c.e, "click");
  assert.deepEqual({ i: c.i, x: c.x, t: c.t }, { i: "signup", x: "Sign up", t: "BUTTON" });
});

check("click on a non-interactive element is ignored", () => {
  const r = run();
  r.click(el({ tagName: "SPAN", textContent: "just text" }));
  assert.equal(r.sent.length, 1);
});

check("form submit is captured", () => {
  const r = run();
  r.submit(el({ tagName: "FORM", id: "contact", name: "", attrs: { action: "/send" } }));
  const f = r.sent[1];
  assert.equal(f.e, "form_submit");
  assert.deepEqual({ i: f.i, h: f.h, t: f.t }, { i: "contact", h: "/send", t: "FORM" });
});

console.log("dataLayer");

check("plain object events pass through as dl", () => {
  const r = run();
  r.win.dataLayer.push({ event: "purchase", value: 99 });
  assert.equal(r.sent[1].e, "purchase");
  assert.equal(r.sent[1].dl.value, 99);
});

check("GTM internal events are ignored", () => {
  const r = run();
  r.win.dataLayer.push({ event: "gtm.load" });
  assert.equal(r.sent.length, 1);
});

check("any gtm.* namespaced event is ignored, not just a known list", () => {
  const r = run();
  for (const e of ["gtm.load", "gtm.dom", "gtm.someFutureThing", "gtm.scrollDepth"])
    r.win.dataLayer.push({ event: e });
  assert.equal(r.sent.length, 1, "none of the gtm.* events should be sent");
  r.win.dataLayer.push({ event: "gtmNotNamespaced" });
  assert.equal(r.sent.length, 2, "a name merely starting with gtm is a real event");
});

check("original dataLayer.push still runs", () => {
  const r = run();
  r.win.dataLayer.push({ event: "purchase" });
  assert.equal(r.win.dataLayer.length, 1, "item must still be appended");
});

check("a refused sendBeacon falls back instead of dropping the event", () => {
  // stub sendBeacon that refuses everything, as browsers do when the queue is full
  const sent = [];
  const noop = () => {};
  const location = { pathname: "/p", search: "", hostname: "site.test" };
  const win = {
    dataLayer: [], location,
    document: { currentScript: { dataset: {}, src: "https://w.test/script.js" },
                referrer: "", title: "", addEventListener: noop },
    history: { pushState: noop, replaceState: noop },
    navigator: { sendBeacon: () => false },
    fetch: (_u, o) => (sent.push(JSON.parse(o.body)), Promise.resolve()),
    addEventListener: noop,
    URL, URLSearchParams, JSON, Object, Array, console,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SCRIPT, win);
  assert.equal(sent.length, 1, "event must go out via fetch");
  assert.equal(sent[0].e, "page_view");
});

console.log("web vitals");

check("nothing is sent per observer callback", () => {
  const r = run();
  r.emit("largest-contentful-paint", [{ startTime: 1200 }]);
  r.emit("layout-shift", [{ value: 0.05, hadRecentInput: false }]);
  r.emit("event", [{ interactionId: 1, duration: 80 }]);
  assert.equal(r.sent.length, 1, "only the page_view — vitals wait for page hide");
});

check("one event on hide, carrying all three", () => {
  const r = run();
  r.emit("largest-contentful-paint", [{ startTime: 1200 }]);
  r.emit("layout-shift", [{ value: 0.05, hadRecentInput: false }]);
  r.emit("event", [{ interactionId: 1, duration: 80 }]);
  r.hide();
  const v = r.sent.filter((x) => x.e === "web_vitals");
  assert.equal(v.length, 1, "exactly one web_vitals event");
  assert.deepEqual(v[0].dl, { lcp: 1200, cls: 0.05, inp: 80 });
});

check("CLS accumulates rather than reporting the last shift", () => {
  const r = run();
  r.emit("layout-shift", [{ value: 0.1, hadRecentInput: false }]);
  r.emit("layout-shift", [{ value: 0.05, hadRecentInput: false }]);
  r.emit("layout-shift", [{ value: 0.02, hadRecentInput: false }]);
  r.hide();
  assert.equal(r.sent.at(-1).dl.cls, 0.17, "sum of the shifts, not the last one");
});

check("shifts after recent input are excluded", () => {
  const r = run();
  r.emit("layout-shift", [{ value: 0.1, hadRecentInput: false }]);
  r.emit("layout-shift", [{ value: 0.9, hadRecentInput: true }]);
  r.hide();
  assert.equal(r.sent.at(-1).dl.cls, 0.1);
});

check("INP is the worst interaction, not the most recent", () => {
  const r = run();
  r.emit("event", [{ interactionId: 1, duration: 200 }]);
  r.emit("event", [{ interactionId: 2, duration: 40 }]);
  r.hide();
  assert.equal(r.sent.at(-1).dl.inp, 200);
});

check("event entries without an interactionId are not interactions", () => {
  const r = run();
  r.emit("event", [{ duration: 500 }]);
  r.emit("event", [{ interactionId: 3, duration: 30 }]);
  r.hide();
  assert.equal(r.sent.at(-1).dl.inp, 30);
});

check("LCP takes the latest entry", () => {
  const r = run();
  r.emit("largest-contentful-paint", [{ startTime: 800 }]);
  r.emit("largest-contentful-paint", [{ startTime: 2100 }]);
  r.hide();
  assert.equal(r.sent.at(-1).dl.lcp, 2100);
});

check("reported once, not again on a later hide", () => {
  const r = run();
  r.emit("largest-contentful-paint", [{ startTime: 900 }]);
  r.hide(); r.show(); r.hide();
  assert.equal(r.sent.filter((x) => x.e === "web_vitals").length, 1);
});

check("nothing sent when no vitals were observed", () => {
  const r = run();
  r.hide();
  assert.equal(r.sent.filter((x) => x.e === "web_vitals").length, 0);
});

process.exit(failures ? 1 : 0);
