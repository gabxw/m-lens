import esbuild from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outDir = path.resolve(".mlens-test");
const outFile = path.join(outDir, "tests.mjs");

await mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: ["scripts/tests.ts"],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
});

await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`);
