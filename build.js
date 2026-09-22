// Builds dist/otag.js - the browser script, one bundle, no configuration.
//
// A release build also writes worker/src/otag.generated.ts, the same bytes as a
// string. Workers cannot read files at runtime, and Deploy to Cloudflare builds
// worker/ on its own, so the script has to be committed inside it.

import { build } from "esbuild";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
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

// Only on a minified build: --dev output must never reach the committed module.
if (!process.argv.includes("--dev")) {
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  writeFileSync(
    "worker/src/otag.generated.ts",
    `// GENERATED - do not edit. Run \`npm run build\`.\n` +
      `// Source: src/otag.ts at v${version}\n\n` +
      `export const OTAG_VERSION = ${JSON.stringify(version)};\n` +
      `export const OTAG_SCRIPT = ${JSON.stringify(out)};\n`
  );
  console.log("worker/src/otag.generated.ts  updated");
}
