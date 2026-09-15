// Builds dist/otag.js - the browser script, one bundle, no configuration.

import { build } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";

const result = await build({
  entryPoints: ["src/otag.ts"],
  bundle: true,
  format: "iife",
  target: ["es2018"],
  minify: !process.argv.includes("--dev"),
  write: false,
  logLevel: "info",
});

const out = result.outputFiles[0].text;
mkdirSync("dist", { recursive: true });
writeFileSync("dist/otag.js", out);

const buf = Buffer.from(out);
console.log(
  `dist/otag.js  raw ${buf.length}b  gzip ${gzipSync(buf, { level: 9 }).length}b  brotli ${brotliCompressSync(buf).length}b`
);
