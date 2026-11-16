// Bundles scripts/cli.ts into dist/cli.mjs for the container image (the native SQLite module stays external).
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: "dist/cli.mjs",
  external: ["better-sqlite3"],
  banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" },
});
