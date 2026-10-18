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

console.log("ingest-context: ok");
