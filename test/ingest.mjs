// handleTrack (worker/src/ingest.ts) against a fake D1 that records the
// insert: what each payload and request.cf shape is stored as.

import { build } from "esbuild";
import assert from "node:assert/strict";

const out = await build({
  entryPoints: [new URL("../worker/src/ingest.ts", import.meta.url).pathname],
  bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "warning",
});
const m = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

function fakeDb() {
  const inserts = [];
  return {
    inserts,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => (sql.startsWith("SELECT value FROM meta") ? { value: "salt" } : null),
            run: async () => {
              if (sql.includes("INSERT INTO events")) {
                const cols = /\(([^)]*)\)\s*VALUES/.exec(sql)[1].split(",").map((c) => c.trim());
                assert.equal(cols.length, args.length, "one value per column");
                inserts.push(Object.fromEntries(cols.map((c, i) => [c, args[i]])));
              }
              return {};
            },
          };
        },
      };
    },
  };
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

async function track(payload, cf) {
  const db = fakeDb();
  const req = new Request("https://oa.example.com/t", {
    method: "POST",
    headers: { "User-Agent": UA, "Accept-Language": "pl-PL,pl;q=0.9", "CF-Connecting-IP": "203.0.113.7", "CF-IPCountry": "PL" },
    body: JSON.stringify(payload),
  });
  if (cf) Object.defineProperty(req, "cf", { value: cf });
  const res = await m.handleTrack(req, { DB: db });
  assert.equal(res.status, 200);
  assert.equal(db.inserts.length, 1);
  return db.inserts[0];
}

// request.cf as Cloudflare hands it to a Worker: an HTTP/2 request from
// Orange Polska via Warsaw, and an HTTP/3 one with no clientTcpRtt.
const CF_TCP = { asn: 5617, asOrganization: "Orange Polska Spolka Akcyjna", colo: "WAW", city: "Kraków", country: "PL", clientTcpRtt: 23, httpProtocol: "HTTP/2" };
const CF_QUIC = { asn: 5617, asOrganization: "Orange Polska Spolka Akcyjna", colo: "WAW", city: "Kraków", country: "PL", httpProtocol: "HTTP/3" };

const v032 = { e: "page_view", p: "/", d: "konkret.studio", r: "https://www.google.com/", z: "Europe/Warsaw" };

let row = await track(v032, CF_TCP);
assert.equal(row.tz, "Europe/Warsaw");
assert.equal(row.colo, "WAW");
assert.equal(row.rtt, 20, "23 ms rounded to 10");
assert.equal(row.asn, 5617);
assert.equal(row.dc, 0);

row = await track(v032, CF_QUIC);
assert.equal(row.rtt, null, "HTTP/3: no clientTcpRtt");
assert.equal(row.colo, "WAW");

row = await track(v032, { ...CF_TCP, clientTcpRtt: 0 });
assert.equal(row.rtt, null, "0 is no measurement");

row = await track(v032, { ...CF_TCP, clientTcpRtt: 145 });
assert.equal(row.rtt, 150);

// A page still on a cached 0.3.1 script: no z. Everything new is null.
const v031 = { e: "page_view", p: "/", d: "konkret.studio", r: "https://www.google.com/" };
row = await track(v031, CF_TCP);
assert.equal(row.tz, null);
assert.equal(row.site_id, "konkret.studio");

// Outside Cloudflare (local dev): no request.cf at all.
row = await track(v031, undefined);
assert.deepEqual([row.colo, row.rtt, row.asn, row.dc, row.tz], [null, null, null, null, null]);

// The engaged event as otag 0.3.2 sends it.
row = await track({ ...v032, e: "engaged", b: { t: 1840, k: "s" } }, CF_TCP);
assert.equal(row.event_name, "engaged");
assert.deepEqual(JSON.parse(row.event_data), { t: 1840, k: "s" });

// Junk in z is stored as null, the event still is.
for (const z of ["", "Europe/Warsaw; DROP TABLE events", "<script>", "../etc/passwd", "a//b", "/Europe", "GMT+03:00", 42, null, {}, "A".repeat(65)]) {
  row = await track({ ...v032, z }, CF_TCP);
  assert.equal(row.tz, null, JSON.stringify(z));
}
for (const z of ["Europe/Warsaw", "America/Argentina/Buenos_Aires", "Etc/GMT+3", "Etc/GMT-14", "UTC", "America/Port-au-Prince"]) {
  row = await track({ ...v032, z }, CF_TCP);
  assert.equal(row.tz, z);
}

// A tier 1a hosting network (EGIHosting) is a datacenter now.
row = await track(v032, { asn: 18779, asOrganization: "EGIHOSTING", colo: "SJC", clientTcpRtt: 3 });
assert.equal(row.dc, 1);
assert.equal(row.rtt, 0, "a real 3 ms rounds to 0");

console.log("ingest: ok");
