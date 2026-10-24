#!/usr/bin/env node
/**
 * Build the server and CLI into self-contained ESM bundles.
 *
 * Workspace packages are bundled in; npm dependencies are bundled too, except
 * native modules (better-sqlite3) which must resolve from node_modules at
 * runtime. The web app is built separately by Vite.
 */
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";

const outDir = process.env.CORPIX_BUILD_DIR ?? "dist";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  // Native addons cannot be bundled. Everything else is inlined so the output
  // does not depend on workspace source files at runtime.
  external: ["better-sqlite3"],
  banner: {
    js: [
      "import { createRequire as __corpixCreateRequire } from 'node:module';",
      "const require = __corpixCreateRequire(import.meta.url);",
    ].join("\n"),
  },
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  ...shared,
  entryPoints: ["apps/server/src/index.ts"],
  outfile: `${outDir}/server.mjs`,
});

await build({
  ...shared,
  entryPoints: ["apps/cli/src/index.ts"],
  outfile: `${outDir}/cli.mjs`,
});

process.stdout.write(`Built ${outDir}/server.mjs and ${outDir}/cli.mjs\n`);
