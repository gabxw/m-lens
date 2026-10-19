// Smoke test do linter: compila src/lint/lint.ts em memória e roda nas amostras.
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const outDir = mkdtempSync(join(tmpdir(), "mlens-smoke-"));
const outFile = join(outDir, "lint.mjs");

await esbuild.build({
  entryPoints: ["src/lint/lint.ts"],
  bundle: true,
  outfile: outFile,
  format: "esm",
  platform: "node",
  target: "node18",
  logLevel: "silent",
});

const { lintDocument } = await import(pathToFileURL(outFile).href);

const sample = readFileSync("samples/exemplo.pq", "utf8");
const findings = await lintDocument(sample);

console.log(JSON.stringify(findings, null, 2));

const ruleIds = findings.map((f) => f.ruleId).sort();
const expected = ["generic-step-name", "hardcoded-path", "table-buffer", "unused-step"];
const missing = expected.filter((r) => !ruleIds.includes(r));

// Aplica o quick fix de remoção do step não usado e re-linta: o resultado deve parsear.
const unused = findings.find((f) => f.ruleId === "unused-step");
if (unused && unused.removalRange) {
  const lines = sample.split("\n");
  const { start, end } = unused.removalRange;
  const before = lines.slice(0, start.line).join("\n") + (start.line > 0 ? "\n" : "") + lines[start.line].slice(0, start.character);
  const after = lines[end.line].slice(end.character) + "\n" + lines.slice(end.line + 1).join("\n");
  const edited = before + after;
  const findings2 = await lintDocument(edited);
  console.log("--- após quick fix ---");
  console.log(edited);
  console.log("findings após fix:", findings2.map((f) => f.ruleId));
}

rmSync(outDir, { recursive: true, force: true });

if (missing.length > 0) {
  console.error("FALHOU: regras não disparadas:", missing);
  process.exit(1);
}

console.log("SMOKE OK");
