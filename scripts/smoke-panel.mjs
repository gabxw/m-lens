// Smoke test do painel de resultado: executa o HTML gerado num DOM real (jsdom)
// e verifica que o script não explode e que os recursos funcionam — inclusive no
// cenário de reuso do painel, quando acquireVsCodeApi() lança.
import * as esbuild from "esbuild";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { JSDOM, VirtualConsole } from "jsdom";

const outDir = mkdtempSync(join(tmpdir(), "mlens-smoke-panel-"));
const outFile = join(outDir, "core.mjs");

await esbuild.build({
  entryPoints: ["src/preview/resultPanelCore.ts"],
  bundle: true,
  outfile: outFile,
  format: "esm",
  platform: "node",
  target: "node18",
  logLevel: "silent",
});

const { renderHtml } = await import(pathToFileURL(outFile).href);

const rows = Array.from({ length: 20 }, (_, i) => ({
  Id: i + 1,
  Nome: `Item ${i + 1}`,
  Output: `Linha longa de texto ${i} - ${"conteudo extenso que estoura a coluna ".repeat(6)}`,
  Ativo: i % 2 === 0,
}));

const html = renderHtml("teste.pq", JSON.stringify({ Output: rows }), {}, 500);

const failures = [];

function makeDom(simulateReuse) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("error", (...args) => errors.push(args.map(String).join(" ")));
  virtualConsole.on("jsdomError", (err) => errors.push(String(err)));

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    virtualConsole,
    pretendToBeVisual: true,
  });

  // Stub do acquireVsCodeApi: na primeira carga funciona; no reuso do painel, lança.
  dom.window.acquireVsCodeApi = simulateReuse
    ? () => { throw new Error("An instance of the VS Code API has already been acquired"); }
    : () => ({ postMessage: () => {} });

  // Executa o <script> embutido manualmente (runScripts outside-only não roda scripts do HTML).
  const scriptText = dom.window.document.querySelector("script").textContent;
  dom.window.eval(scriptText);

  return { dom, errors };
}

for (const simulateReuse of [false, true]) {
  const label = simulateReuse ? "painel reutilizado" : "primeira carga";
  const { dom, errors } = makeDom(simulateReuse);
  const { document } = dom.window;

  // O guard de acquire-api loga o erro no console — isso é esperado no reuso.
  const fatalErrors = errors.filter((e) => !e.includes("acquire-api"));

  if (fatalErrors.length > 0) {
    failures.push(`[${label}] erros no script: ${fatalErrors.join(" | ")}`);
  }

  // 1. Tabela ganhou layout fixo e classe user-sized
  const table = document.querySelector("#dataTable");
  if (!table || table.style.tableLayout !== "fixed" || !table.classList.contains("user-sized")) {
    failures.push(`[${label}] tabela não inicializou (layout fixo/user-sized)`);
  }

  // 2. Todas as colunas receberam largura
  const cols = [...document.querySelectorAll("colgroup col")];
  if (cols.length !== 4 || cols.some((c) => !c.style.width.endsWith("px"))) {
    failures.push(`[${label}] larguras de coluna não definidas: ${cols.map((c) => c.style.width).join(",")}`);
  }

  // 3. Alças de redimensionamento presentes em todos os cabeçalhos
  const resizers = [...document.querySelectorAll("th .col-resizer")];
  if (resizers.length !== 4) {
    failures.push(`[${label}] esperava 4 alças, achou ${resizers.length}`);
  }

  // 4. Arrastar a alça muda a largura da coluna (mousedown -> mousemove -> mouseup)
  const col2 = cols[2];
  const before = parseFloat(col2.style.width);
  const opts = { bubbles: true, cancelable: true, view: dom.window };
  resizers[2].dispatchEvent(new dom.window.MouseEvent("mousedown", { ...opts, clientX: 200 }));
  document.dispatchEvent(new dom.window.MouseEvent("mousemove", { ...opts, clientX: 290 }));
  document.dispatchEvent(new dom.window.MouseEvent("mouseup", opts));
  const after = parseFloat(col2.style.width);
  if (Math.round(after - before) !== 90) {
    failures.push(`[${label}] arraste não redimensionou: ${before} -> ${after} (esperava +90)`);
  }

  // 5. Painel de baixo: seletor de coluna default = "Output"; mostra só uma coluna
  const select = document.querySelector("#detailColumn");
  const valueBox = document.querySelector("#detailValue");
  if (!select || !valueBox) {
    failures.push(`[${label}] painel de baixo (seletor/valor) não renderizou`);
  } else {
    // colunas: Id(0) Nome(1) Output(2) Ativo(3) -> default deve ser Output (índice 2)
    if (select.value !== "2") {
      failures.push(`[${label}] coluna padrão deveria ser Output (2), veio ${select.value}`);
    }
    // Abre já com a 1ª linha: valor mostra o Output longo da linha 0
    if (!valueBox.textContent.includes("conteudo extenso")) {
      failures.push(`[${label}] painel não abriu mostrando o Output da primeira linha`);
    }
    // Clica na 5ª linha
    const targetRow = document.querySelectorAll("tbody tr")[4];
    targetRow.dispatchEvent(new dom.window.MouseEvent("click", opts));
    if (document.querySelectorAll("tbody tr.selected").length !== 1) {
      failures.push(`[${label}] mais de uma linha ficou selecionada`);
    }
    if (!valueBox.textContent.includes("Linha longa de texto 4")) {
      failures.push(`[${label}] painel não atualizou para o Output da linha clicada`);
    }
    // Troca o seletor para "Nome" -> deve mostrar "Item 5"
    select.value = "1";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    if (valueBox.textContent !== "Item 5") {
      failures.push(`[${label}] trocar a coluna não atualizou o valor (veio "${valueBox.textContent}")`);
    }
  }

  // 6. Busca filtra linhas
  const search = document.querySelector("#search");
  search.value = "Item 3";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const hidden = document.querySelectorAll("tbody tr.hidden").length;
  if (hidden !== 19) {
    failures.push(`[${label}] busca deveria esconder 19 linhas, escondeu ${hidden}`);
  }

  // 7. O clique fantasma logo após o arraste é suprimido; o seguinte ordena.
  const th0 = document.querySelectorAll("th[data-column]")[0];
  th0.dispatchEvent(new dom.window.MouseEvent("click", opts));
  if (th0.hasAttribute("data-direction")) {
    failures.push(`[${label}] clique fantasma pós-arraste não foi suprimido`);
  }
  th0.dispatchEvent(new dom.window.MouseEvent("click", opts));
  if (!th0.hasAttribute("data-direction")) {
    failures.push(`[${label}] ordenação não funcionou no clique seguinte`);
  }

  console.log(`[${label}] OK — colunas: ${cols.map((c) => c.style.width).join(", ")}`);
}

// 8. Formato REAL do PQTest: envelope em array com metadados + Output aninhado.
// A tabela deve mostrar os dados (Id, Produto...), nunca as colunas do envelope.
{
  const envelope = [
    {
      ActivityId: "abc",
      Status: "Passed",
      RowCount: 2,
      DataSourceAnalysis: [{ Kind: "DataSource" }],
      Output: [
        { Id: 1, Produto: "Notebook", Observacao: "texto longo um" },
        { Id: 2, Produto: "Mouse", Observacao: "texto longo dois" },
      ],
    },
  ];
  const envHtml = renderHtml("real.pq", JSON.stringify(envelope), {}, 500);
  const envDom = new JSDOM(envHtml);
  const headerNames = [...envDom.window.document.querySelectorAll("th[data-name]")].map((th) =>
    th.getAttribute("data-name"),
  );
  const expectedCols = ["Id", "Produto", "Observacao"];
  if (JSON.stringify(headerNames) !== JSON.stringify(expectedCols)) {
    failures.push(`[envelope real] tabela deveria ter ${expectedCols.join(",")}, veio ${headerNames.join(",")}`);
  }
  if (headerNames.includes("ActivityId") || headerNames.includes("Status")) {
    failures.push(`[envelope real] colunas do envelope vazaram para a tabela`);
  }
  const bodyRows = envDom.window.document.querySelectorAll("tbody tr").length;
  if (bodyRows !== 2) {
    failures.push(`[envelope real] esperava 2 linhas de dados, veio ${bodyRows}`);
  }
  if (failures.length === 0) console.log("[envelope real] OK — colunas:", headerNames.join(", "));
}

rmSync(outDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error("FALHOU:\n" + failures.join("\n"));
  process.exit(1);
}

console.log("SMOKE PANEL OK");
