// isLocalHostname (worker/src/utils.ts): local and dev hostnames are not stored.
// Once Analytics has the same rule (src/instance.ts) and the same cases.

import { build } from "esbuild";
import assert from "node:assert/strict";

const out = await build({
  entryPoints: [new URL("../worker/src/utils.ts", import.meta.url).pathname],
  bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "warning",
});
const m = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

const LOCAL = [
  "localhost", "app.localhost", "127.0.0.1", "127.9.9.9", "::1", "[::1]", "0.0.0.0",
  "10.1.2.3", "172.16.0.5", "172.31.255.1", "192.168.1.20", "169.254.10.10",
  "fc00::1", "fd12:3456::1", "fe80::1", "mac.local", "db.internal", "a.test", "foo.example",
  "x.invalid", "8.8.8.8", "localhost:3000", "127.0.0.1:8788",
];
const REAL = ["example.com", "konkret.studio", "kalafiornia.pl", "casm.si", "www.example.com", "localhost.com", "mylocal.dev"];

for (const h of LOCAL) assert.equal(m.isLocalHostname(h), true, h);
for (const h of REAL) assert.equal(m.isLocalHostname(h), false, h);
assert.equal(m.isLocalHostname(undefined), false);

console.log("local-hostnames: ok");
