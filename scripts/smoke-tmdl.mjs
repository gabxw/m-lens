// Smoke test do extrator TMDL: extrai, modifica, reaplica e re-extrai.
import * as esbuild from "esbuild";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const outDir = mkdtempSync(join(tmpdir(), "mlens-smoke-tmdl-"));
const outFile = join(outDir, "tmdlCore.mjs");

await esbuild.build({
  entryPoints: ["src/pbip/tmdlCore.ts"],
  bundle: true,
  outfile: outFile,
  format: "esm",
  platform: "node",
  target: "node18",
  logLevel: "silent",
});

const { extractBlocks, applyBlockToText } = await import(pathToFileURL(outFile).href);

const tmdl = readFileSync("samples/exemplo.tmdl", "utf8");

// 1. Extração
const blocks = extractBlocks(tmdl);
console.log("blocos:", blocks.map((b) => ({ name: b.name, kind: b.kind, headerLine: b.headerLine, endLine: b.endLine })));

if (blocks.length !== 1 || blocks[0].name !== "Vendas" || blocks[0].kind !== "partition-source") {
  console.error("FALHOU: esperado 1 bloco partition-source 'Vendas'");
  process.exit(1);
}

if (!blocks[0].code.startsWith("let") || !blocks[0].code.includes('#"Changed Type"')) {
  console.error("FALHOU: código extraído incorreto:\n" + blocks[0].code);
  process.exit(1);
}

if (blocks[0].code.includes("annotation")) {
  console.error("FALHOU: annotation vazou para o código extraído");
  process.exit(1);
}

console.log("--- código extraído ---\n" + blocks[0].code);

// 2. Reaplicação com código modificado
const newCode = blocks[0].code.replace('[Delimiter = ";"]', '[Delimiter = ",", Encoding = 65001]');
const updated = applyBlockToText(tmdl, "Vendas", "partition-source", newCode);

if (updated === undefined) {
  console.error("FALHOU: applyBlockToText não encontrou o bloco");
  process.exit(1);
}

console.log("--- tmdl atualizado ---\n" + updated);

// 3. Round-trip: re-extrai e compara
const blocks2 = extractBlocks(updated);

if (blocks2.length !== 1 || blocks2[0].code.trim() !== newCode.trim()) {
  console.error("FALHOU: round-trip divergiu.\nEsperado:\n" + newCode + "\nObtido:\n" + (blocks2[0]?.code ?? "(nenhum)"));
  process.exit(1);
}

// 4. A annotation e o restante do arquivo devem permanecer intactos
if (!updated.includes("annotation PBI_ResultType = Table") || !updated.includes("mode: import")) {
  console.error("FALHOU: conteúdo TMDL fora do bloco foi perdido");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
console.log("SMOKE TMDL OK");
