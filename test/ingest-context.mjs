// The worker's request context helpers (worker/src/ingest-context.ts), bundled
// on the fly. Once Analytics holds a byte-for-byte copy and tests it more
// fully; this guards the copy that otag ships.

import { build } from "esbuild";
import assert from "node:assert/strict";

const out = await build({
  entryPoints: [new URL("../worker/src/ingest-context.ts", import.meta.url).pathname],
  bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "warning",
});
const m = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

const IG = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.23.114 (iPhone14,5; iOS 17_0; pl_PL; pl)";
const MSG = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/430.0;FBBV/1;FBDV/iPhone14,5]";
const FB = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.0;]";

assert.equal(m.detectInApp(IG), "instagram");
assert.equal(m.detectInApp(MSG), "messenger", "Messenger carries Facebook tokens too");
assert.equal(m.detectInApp(FB), "facebook");
assert.equal(m.detectInApp("Mozilla/5.0 (Macintosh) Chrome/120.0 Safari/537.36"), null);
assert.equal(m.primaryLanguage("pl-PL,pl;q=0.9,en;q=0.8"), "pl");
assert.equal(m.primaryLanguage(null), null);
assert.equal(m.isDatacenter({ asn: 16509, asOrganization: "Amazon.com, Inc." }), 1);
assert.equal(m.isDatacenter({ asn: 5617, asOrganization: "Orange Polska Spolka Akcyjna" }), 0);
assert.equal(m.isDatacenter({ asn: 13335, asOrganization: "Cloudflare, Inc." }), 0, "WARP and Private Relay are people");
assert.equal(m.isDatacenter(undefined), null);

assert.equal(m.asnOf({ asn: 5617 }), 5617);
assert.equal(m.asnOf({}), null);
assert.equal(m.asnOf(undefined), null);

// Tier 1a hosting networks (BOT_TRAFFIC_SWEEP.md section 4); tier 1b VPN hosts are not.
for (const asn of [18779, 262287, 396356, 26832, 44486, 62874, 11798, 214036, 214677, 216139, 212341, 399275, 140577, 7941, 13238, 37963, 132510, 134543])
  assert.equal(m.isDatacenter({ asn }), 1, String(asn));
for (const asn of [203020, 207990, 149428, 206092, 208172, 32934, 22295, 62044])
  assert.equal(m.isDatacenter({ asn }), 0, String(asn));

assert.equal(m.coloOf({ colo: "WAW" }), "WAW");
assert.equal(m.coloOf({ colo: "waw" }), null);
assert.equal(m.coloOf({}), null);
assert.equal(m.rttOf({ clientTcpRtt: 23 }), 20);
assert.equal(m.rttOf({ clientTcpRtt: 25 }), 30);
assert.equal(m.rttOf({}), null, "HTTP/3");
assert.equal(m.rttOf({ clientTcpRtt: 0 }), null);
assert.equal(m.rttOf(undefined), null);
for (const z of ["Europe/Warsaw", "America/Argentina/Buenos_Aires", "Etc/GMT+3", "UTC"]) assert.equal(m.timeZoneOf(z), z);
for (const z of [undefined, "", "Europe/Warsaw'--", "x".repeat(65), 3]) assert.equal(m.timeZoneOf(z), null);

const req = (h) => new Request("https://oa.example.com/t", { method: "POST", headers: h });
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CH = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
assert.equal(m.detectAutomation(req({ "User-Agent": CHROME, "Sec-CH-UA": CH, "Sec-CH-UA-Platform": '"Windows"' })), null);
assert.equal(m.detectAutomation(req({ "User-Agent": CHROME, "Sec-CH-UA": CH }), 1), "Webdriver");
assert.equal(m.detectAutomation(req({ "User-Agent": CHROME, "Sec-CH-UA": '"Chromium";v="156", "HeadlessChrome";v="156"' })), "Headless");
assert.equal(m.detectAutomation(req({ "User-Agent": CHROME, "Sec-CH-UA": '"Chromium";v="156"' })), "Spoofed UA");
assert.equal(m.detectAutomation(req({ "User-Agent": CHROME, "Sec-CH-UA": CH, "Sec-CH-UA-Platform": '"Linux"' })), "Spoofed UA");
assert.equal(m.detectAutomation(req({ "User-Agent": CHROME })), "Spoofed UA", "a plain Chrome UA without client hints");
assert.equal(m.detectAutomation(req({ "User-Agent": FB })), null, "in-app browsers are never judged by missing hints");

// link_url as stored: the real addresses clicks sent, query and fragment cut.
const CF = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22d1%22%7D%5D&accountId=0f1e2d3c4b5a69788796a5b4c3d2e1f0";
assert.equal(m.linkAddress(CF), "https://dash.cloudflare.com/profile/api-tokens");
assert.equal(m.linkAddress("mailto:contact@getrelight.dev?subject=Hello"), "mailto:contact@getrelight.dev");
assert.equal(m.linkAddress("/en/coworking/?utm_source=x"), "/en/coworking/");
assert.equal(m.linkAddress("tel:+48600100200"), "tel:+48600100200");
assert.deepEqual(m.storedEventData({ link_id: "cta", link_text: "Create a token", link_url: CF }),
  { link_id: "cta", link_text: "Create a token", link_url: "https://dash.cloudflare.com/profile/api-tokens" });
assert.deepEqual(m.storedEventData({ link_text: "Top", link_url: "#top" }), { link_text: "Top" }, "nothing left of the address");
assert.deepEqual(m.storedEventData({ value: 99, currency: "USD" }), { value: 99, currency: "USD" }, "other events untouched");
assert.equal(m.storedEventData(undefined), undefined);

console.log("ingest-context: ok");
