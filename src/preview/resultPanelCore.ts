/**
 * Renderização pura do painel de resultado — sem dependência do VS Code,
 * para permitir teste do HTML/JS gerado em Node (jsdom).
 *
 * Decisões importantes do script embutido:
 *  - acquireVsCodeApi() é protegido por try/catch: ele só pode ser chamado UMA
 *    vez na vida do webview; quando o painel é reutilizado (segunda avaliação),
 *    a chamada lança e, sem a proteção, matava busca/ordenação/expandir/arrastar.
 *  - Cada recurso do script é isolado em seu próprio try/catch ("safe"), então
 *    uma falha pontual não derruba o resto.
 *  - A largura inicial de cada coluna é medida pelo CONTEÚDO (scrollWidth das
 *    células, amostrado), não pelo cabeçalho — coluna com texto longo abre
 *    larga (até 520px) e legível, com scroll horizontal na moldura da tabela.
 */

export interface ResultPanelOptions {
    readonly kind?: "data" | "error";
    readonly error?: string;
    readonly credentialCount?: number;
    readonly probablyCredentialError?: boolean;
}

interface RowsResult {
    readonly rows: ReadonlyArray<Record<string, unknown>>;
    readonly path: string;
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Textos do painel. O padrão é inglês; a extensão passa as traduções (l10n). */
export interface ResultPanelStrings {
    readonly subtitle: string;
    readonly credentials: string;
    readonly filterLabel: string;
    readonly filterPlaceholder: string;
    /** "{0} of {1} rows" — {0} visíveis, {1} total. */
    readonly rowsSummary: string;
    /** "Showing the first {0} of {1} rows (mlens.preview.maxRows)". */
    readonly truncated: string;
    readonly columns: string;
    readonly credentialsUsed: string;
    readonly textResult: string;
    readonly jsonResult: string;
    readonly detailColumn: string;
    /** "Row {0}" */
    readonly row: string;
    readonly empty: string;
    readonly detailHint: string;
    readonly resize: string;
    readonly sortHint: string;
    readonly errorTitle: string;
    readonly credentialHintTitle: string;
    readonly credentialHint: string;
    readonly genericHint: string;
    readonly manageCredentials: string;
    readonly showLog: string;
    readonly unknownError: string;
}

export const DEFAULT_STRINGS: ResultPanelStrings = {
    subtitle: "Data preview with PQTest",
    credentials: "Credentials",
    filterLabel: "Filter rows",
    filterPlaceholder: "Filter rows…",
    rowsSummary: "{0} of {1} rows",
    truncated: "Showing the first {0} of {1} rows (mlens.preview.maxRows)",
    columns: "{0} columns",
    credentialsUsed: "Credentials used: {0}",
    textResult: "Text result",
    jsonResult: "JSON result",
    detailColumn: "Column",
    row: "Row {0}",
    empty: "(empty)",
    detailHint: "Select a row to read its full values here.",
    resize: "Drag to resize",
    sortHint: "Select a column header to sort",
    errorTitle: "The query failed",
    credentialHintTitle: "This looks like a credential problem.",
    credentialHint:
        "Run the preview again to choose a login, or open Manage credentials to change a saved one. Sources with organizational sign-in (SharePoint Online, OAuth) still need a credential set up with the Power Query SDK.",
    genericHint: "Show log has the full PQTest output.",
    manageCredentials: "Manage credentials",
    showLog: "Show log",
    unknownError: "Unknown error.",
};

export interface ResultPanelEnvironment {
    readonly strings?: ResultPanelStrings;
    /** webview.cspSource — vazio em teste. */
    readonly cspSource?: string;
    readonly nonce?: string;
}

function format(template: string, ...values: (string | number)[]): string {
    return template.replace(/\{(\d+)\}/g, (_match: string, index: string) => String(values[Number(index)] ?? ""));
}

/** JSON seguro para embutir em <script>: sem "</script>" nem separadores de linha JS. */
function scriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderHtml(
    title: string,
    rawOutput: string,
    options: ResultPanelOptions,
    maxRows: number,
    environment: ResultPanelEnvironment = {},
): string {
    const strings: ResultPanelStrings = environment.strings ?? DEFAULT_STRINGS;
    const nonce: string = environment.nonce ?? "mlens";
    const body: string =
        options.kind === "error"
            ? renderError(options, strings)
            : renderBody(rawOutput, maxRows, options.credentialCount ?? 0, strings);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${environment.cspSource ?? ""} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  /* Só cores do tema do VS Code: o painel acompanha claro, escuro e alto contraste. */
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground, var(--vscode-foreground));
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
    --contrast: var(--vscode-contrastBorder, transparent);
    --header-bg: var(--vscode-editorWidget-background, var(--bg));
    --zebra: color-mix(in srgb, var(--fg) 4%, transparent);
    --hover: var(--vscode-list-hoverBackground, var(--zebra));
    --selected-bg: var(--vscode-list-inactiveSelectionBackground, var(--hover));
    --selected-fg: var(--vscode-list-inactiveSelectionForeground, var(--fg));
    --focus: var(--vscode-focusBorder);
    --error: var(--vscode-errorForeground);
    --code-bg: var(--vscode-textCodeBlock-background, var(--header-bg));
  }

  body.vscode-light { color-scheme: light; }
  body.vscode-dark, body.vscode-high-contrast { color-scheme: dark; }
  body.vscode-high-contrast-light { color-scheme: light; }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
  }

  :focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; }

  .visually-hidden {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* Coluna em altura cheia: a tabela ocupa o que sobra entre a barra e o detalhe. */
  html, body { height: 100%; }
  .wrap { height: 100%; display: flex; flex-direction: column; padding: 16px 20px; }

  .top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 12px;
  }

  h1 { margin: 0 0 2px; font-size: 1.4em; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
  .sub { color: var(--muted); }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    margin: 0 0 10px;
  }

  .summary { color: var(--muted); }

  input, select {
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--contrast));
    border-radius: 2px;
  }

  input { width: min(320px, 100%); height: 26px; padding: 0 6px; }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  input:focus, select:focus { outline: 1px solid var(--focus); outline-offset: -1px; }

  select {
    height: 26px;
    padding: 0 4px;
    color: var(--vscode-dropdown-foreground, var(--fg));
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    border-color: var(--vscode-dropdown-border, var(--contrast));
  }

  button {
    font-family: inherit;
    font-size: inherit;
    min-height: 26px;
    padding: 4px 12px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    cursor: pointer;
  }

  button:hover { background: var(--vscode-button-hoverBackground); }

  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }

  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

  .table-shell {
    flex: 1 1 auto;
    min-height: 140px;
    overflow: auto;
    border: 1px solid var(--border);
  }

  table { border-collapse: separate; border-spacing: 0; }

  th, td {
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    padding: 4px 8px;
    text-align: left;
    vertical-align: top;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--header-bg);
    font-weight: 600;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  th[aria-sort="ascending"]::after { content: " \\2191"; color: var(--muted); }
  th[aria-sort="descending"]::after { content: " \\2193"; color: var(--muted); }

  /* Alça de redimensionamento na borda direita de cada cabeçalho. */
  .col-resizer {
    position: absolute;
    top: 0;
    right: 0;
    width: 8px;
    height: 100%;
    cursor: col-resize;
    z-index: 2;
  }

  .col-resizer:hover,
  .col-resizer.dragging { background: var(--focus); }

  body.resizing { cursor: col-resize; user-select: none; }
  body.resizing th { cursor: col-resize; }

  td { line-height: 1.4; overflow: hidden; }

  /* O clipping fica num div interno: max-width em <td> não é respeitado no
     layout automático de tabela, então conteúdo longo invadia as colunas vizinhas. */
  td .cell {
    display: block;
    max-width: 520px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Depois que o JS assume as larguras (layout fixo), a coluna manda. */
  table.user-sized td .cell { max-width: none; }

  tbody tr { cursor: pointer; }
  tbody tr:nth-child(even) td { background: var(--zebra); }
  tbody tr:hover td { background: var(--hover); }
  tr.hidden { display: none; }

  tbody tr.selected td {
    background: var(--selected-bg) !important;
    color: var(--selected-fg);
  }

  tbody tr.selected td:first-child { box-shadow: inset 2px 0 0 var(--focus); }

  /* Painel de leitura abaixo da planilha: mostra UMA coluna (Output por padrão)
     da linha selecionada, por inteiro e legível. */
  .detail { flex: 0 0 auto; margin-top: 12px; border: 1px solid var(--border); }

  .detail-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--header-bg);
  }

  .detail-row-label { margin-left: auto; color: var(--muted); }

  .detail-value {
    padding: 10px 12px;
    max-height: 28vh;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }

  .detail-value.mono { font-family: var(--vscode-editor-font-family, monospace); }
  .detail-empty { color: var(--muted); }

  /* Como no editor do Power Query: texto normal, números à direita, null discreto. */
  .cell-null { color: var(--muted); font-style: italic; }
  .cell-number, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .cell-object { font-family: var(--vscode-editor-font-family, monospace); }

  pre {
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    padding: 10px 12px;
    background: var(--code-bg);
    border: 1px solid var(--border);
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .error { border-left: 3px solid var(--error); padding: 2px 0 2px 14px; }
  .error h2 { margin: 0 0 10px; color: var(--error); font-size: 1.15em; font-weight: 600; }
  .error .toolbar { margin-bottom: 12px; }
  .hint { margin-top: 12px; color: var(--muted); line-height: 1.55; max-width: 80ch; }
  .hint strong { color: var(--fg); }
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <div class="sub">${escapeHtml(strings.subtitle)}</div>
      </div>
      ${options.kind === "error" ? "" : `<button class="secondary" data-command="manageCredentials">${escapeHtml(strings.credentials)}</button>`}
    </div>
    ${body}
  </div>
  <script nonce="${nonce}">
  (function () {
    var STRINGS = ${scriptJson({ row: strings.row, empty: strings.empty, resize: strings.resize, rowsSummary: strings.rowsSummary })};

    function fmt(template) {
      var args = Array.prototype.slice.call(arguments, 1);
      return template.replace(/\\{(\\d+)\\}/g, function (_m, i) { return String(args[Number(i)]); });
    }

    function safe(label, fn) {
      try { fn(); } catch (err) { console.error("[mlens] " + label + ":", err); }
    }

    // acquireVsCodeApi só pode ser chamado uma vez por webview — em reuso do
    // painel a chamada lança; sem este guard, o script inteiro morria aqui.
    var vscodeApi;
    safe("acquire-api", function () { vscodeApi = acquireVsCodeApi(); });

    safe("buttons", function () {
      document.querySelectorAll("[data-command]").forEach(function (button) {
        button.addEventListener("click", function () {
          if (vscodeApi) vscodeApi.postMessage({ command: button.getAttribute("data-command") });
        });
      });
    });

    safe("search", function () {
      var search = document.querySelector("#search");
      if (!search) return;
      var total = document.querySelectorAll("tbody tr").length;
      search.addEventListener("input", function () {
        var value = search.value.toLowerCase();
        var visible = 0;
        document.querySelectorAll("tbody tr").forEach(function (row) {
          var show = row.textContent.toLowerCase().indexOf(value) !== -1;
          row.classList.toggle("hidden", !show);
          if (show) visible += 1;
        });
        var counter = document.querySelector("#visibleRows");
        if (counter) counter.textContent = fmt(STRINGS.rowsSummary, visible, total);
      });
    });

    // Painel de baixo: mostra UMA coluna (a escolhida no seletor) da linha selecionada.
    safe("rowdetail", function () {
      var table = document.querySelector("#dataTable");
      var select = document.querySelector("#detailColumn");
      var valueBox = document.querySelector("#detailValue");
      var rowLabel = document.querySelector("#detailRowLabel");
      if (!table || !select || !valueBox) return;

      var rows = Array.prototype.slice.call(table.querySelectorAll("tbody tr"));
      var selectedIndex = -1;

      function render() {
        if (selectedIndex < 0 || !rows[selectedIndex]) return;

        var colIndex = Number(select.value);
        var cells = rows[selectedIndex].querySelectorAll("td");
        var cell = cells[colIndex];
        var inner = cell ? cell.querySelector(".cell") : null;
        var text = inner ? inner.textContent : (cell ? cell.textContent : "");

        // textContent (não innerHTML) para não reinterpretar o conteúdo como HTML.
        valueBox.textContent = text && text.length ? text : STRINGS.empty;
        valueBox.classList.toggle("mono", !!(cell && cell.className.indexOf("cell-object") !== -1));
        if (rowLabel) rowLabel.textContent = fmt(STRINGS.row, selectedIndex + 1);
      }

      function selectRow(row) {
        rows.forEach(function (r) { r.classList.remove("selected"); r.removeAttribute("aria-current"); });
        row.classList.add("selected");
        row.setAttribute("aria-current", "true");
        selectedIndex = rows.indexOf(row);
        render();
      }

      rows.forEach(function (row) {
        row.addEventListener("click", function () { selectRow(row); });
        row.addEventListener("keydown", function (event) {
          var visibleRows = rows.filter(function (r) { return !r.classList.contains("hidden"); });
          var position = visibleRows.indexOf(row);
          var target = null;
          if (event.key === "ArrowDown") target = visibleRows[position + 1];
          if (event.key === "ArrowUp") target = visibleRows[position - 1];
          if (event.key === "Enter" || event.key === " ") target = row;
          if (!target) return;
          event.preventDefault();
          selectRow(target);
          target.focus();
        });
      });

      select.addEventListener("change", render);

      // Abre já com a primeira linha selecionada, para o painel não ficar vazio.
      if (rows.length > 0) {
        rows[0].classList.add("selected");
        rows[0].setAttribute("aria-current", "true");
        selectedIndex = 0;
        render();
      }
    });

    var suppressSortClick = false;

    safe("columns", function () {
      var table = document.querySelector("#dataTable");
      if (!table) return;

      var cols = Array.prototype.slice.call(table.querySelectorAll("colgroup col"));
      var headers = Array.prototype.slice.call(table.querySelectorAll("th[data-column]"));
      if (cols.length === 0 || headers.length === 0) return;

      var MIN = 90, MAX = 520, PAD = 26, SAMPLE = 60;
      var sampleRows = Array.prototype.slice.call(table.querySelectorAll("tbody tr")).slice(0, SAMPLE);

      // Largura inicial = maior conteúdo da coluna (scrollWidth enxerga o texto
      // completo mesmo clipado), limitada a [MIN, MAX].
      headers.forEach(function (header, index) {
        var width = header.scrollWidth || 0;
        sampleRows.forEach(function (row) {
          var cell = row.children[index] && row.children[index].firstElementChild;
          if (cell) width = Math.max(width, cell.scrollWidth || 0);
        });
        if (cols[index]) cols[index].style.width = Math.min(MAX, Math.max(MIN, width + PAD)) + "px";
      });

      function totalWidth() {
        return cols.reduce(function (sum, col) { return sum + (parseFloat(col.style.width) || MIN); }, 0);
      }

      // Layout fixo: cada coluna obedece à sua <col>; a tabela cresce além do
      // contêiner e a .table-shell fornece o scroll horizontal.
      table.style.tableLayout = "fixed";
      table.style.minWidth = "0";
      table.style.width = totalWidth() + "px";
      table.classList.add("user-sized");

      headers.forEach(function (header, index) {
        var resizer = document.createElement("div");
        resizer.className = "col-resizer";
        resizer.title = STRINGS.resize;
        resizer.setAttribute("aria-hidden", "true");
        header.appendChild(resizer);

        resizer.addEventListener("click", function (event) { event.stopPropagation(); });

        resizer.addEventListener("mousedown", function (event) {
          event.preventDefault();
          event.stopPropagation();

          var col = cols[index];
          if (!col) return;

          var startX = event.clientX;
          var startWidth = parseFloat(col.style.width) || header.offsetWidth || MIN;

          resizer.classList.add("dragging");
          document.body.classList.add("resizing");
          suppressSortClick = true;

          function onMove(moveEvent) {
            col.style.width = Math.max(48, startWidth + (moveEvent.clientX - startX)) + "px";
            table.style.width = totalWidth() + "px";
          }

          function onUp() {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            resizer.classList.remove("dragging");
            document.body.classList.remove("resizing");
            // Libera a ordenação só no próximo tick para o mouseup do arraste
            // não disparar o sort da coluna.
            setTimeout(function () { suppressSortClick = false; }, 0);
          }

          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
      });
    });

    safe("sort", function () {
      function sortBy(header) {
        var table = header.closest("table");
        if (!table) return;
        var tbody = table.querySelector("tbody");
        var index = Number(header.getAttribute("data-column"));
        var direction = header.getAttribute("data-direction") === "asc" ? "desc" : "asc";
        document.querySelectorAll("th[data-column]").forEach(function (h) {
          h.removeAttribute("data-direction");
          h.removeAttribute("aria-sort");
        });
        header.setAttribute("data-direction", direction);
        header.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
        var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
        rows.sort(function (a, b) {
          var av = (a.children[index] && a.children[index].textContent) || "";
          var bv = (b.children[index] && b.children[index].textContent) || "";
          return direction === "asc"
            ? av.localeCompare(bv, undefined, { numeric: true })
            : bv.localeCompare(av, undefined, { numeric: true });
        });
        rows.forEach(function (row) { tbody.appendChild(row); });
      }

      document.querySelectorAll("th[data-column]").forEach(function (header) {
        header.addEventListener("click", function () {
          if (suppressSortClick) {
            // Consome o clique fantasma que o navegador dispara ao soltar o
            // arraste sobre o cabeçalho; o próximo clique ordena normalmente.
            suppressSortClick = false;
            return;
          }
          sortBy(header);
        });
        header.addEventListener("keydown", function (event) {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          sortBy(header);
        });
      });
    });
  })();
  </script>
</body>
</html>`;
}

function renderError(options: ResultPanelOptions, strings: ResultPanelStrings): string {
    const hint: string =
        options.probablyCredentialError === true
            ? `<div class="hint"><strong>${escapeHtml(strings.credentialHintTitle)}</strong> ${escapeHtml(strings.credentialHint)}</div>`
            : `<div class="hint">${escapeHtml(strings.genericHint)}</div>`;

    return `<div class="error" role="alert">
        <h2>${escapeHtml(strings.errorTitle)}</h2>
        <div class="toolbar">
            <button data-command="manageCredentials">${escapeHtml(strings.manageCredentials)}</button>
            <button class="secondary" data-command="showLog">${escapeHtml(strings.showLog)}</button>
        </div>
        <pre>${escapeHtml(options.error ?? strings.unknownError)}</pre>
        ${hint}
    </div>`;
}

function renderSummary(parts: readonly string[]): string {
    return `<span class="summary">${parts.map(escapeHtml).join(" · ")}</span>`;
}

function renderBody(rawOutput: string, maxRows: number, credentialCount: number, strings: ResultPanelStrings): string {
    const credentialPart: string[] = credentialCount > 0 ? [format(strings.credentialsUsed, credentialCount)] : [];
    let parsed: unknown;

    try {
        parsed = JSON.parse(rawOutput);
    } catch {
        return `<div class="toolbar">${renderSummary([strings.textResult, ...credentialPart])}</div><pre>${escapeHtml(rawOutput)}</pre>`;
    }

    const result: RowsResult | undefined = findRows(parsed);

    if (result === undefined || result.rows.length === 0) {
        return `<div class="toolbar">${renderSummary([strings.jsonResult, ...credentialPart])}</div><pre>${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
    }

    const visible: ReadonlyArray<Record<string, unknown>> = result.rows.slice(0, maxRows);
    const columns: string[] = [...new Set(visible.flatMap((row: Record<string, unknown>) => Object.keys(row)))];
    const detailColumn: number = chooseDetailColumn(columns, visible);

    const isNumeric = (column: string): boolean =>
        visible.some((row: Record<string, unknown>) => typeof row[column] === "number") &&
        visible.every((row: Record<string, unknown>) => row[column] === null || row[column] === undefined || typeof row[column] === "number");

    const header: string = columns
        .map(
            (column: string, index: number) =>
                `<th scope="col" tabindex="0"${isNumeric(column) ? ' class="num"' : ""} data-column="${index}" data-name="${escapeHtml(column)}" title="${escapeHtml(strings.sortHint)}">${escapeHtml(column)}</th>`,
        )
        .join("");

    const detailOptions: string = columns
        .map(
            (column: string, index: number) =>
                `<option value="${index}"${index === detailColumn ? " selected" : ""}>${escapeHtml(column)}</option>`,
        )
        .join("");

    const bodyRows: string = visible
        .map(
            (row: Record<string, unknown>) =>
                `<tr tabindex="0">${columns.map((column: string) => renderCell(row[column])).join("")}</tr>`,
        )
        .join("\n");

    const truncated: string[] =
        result.rows.length > maxRows ? [format(strings.truncated, maxRows, result.rows.length)] : [];

    return `<div class="toolbar">
        <label class="visually-hidden" for="search">${escapeHtml(strings.filterLabel)}</label>
        <input id="search" type="search" placeholder="${escapeHtml(strings.filterPlaceholder)}" />
        <span class="summary"><span id="visibleRows" aria-live="polite">${escapeHtml(format(strings.rowsSummary, visible.length, visible.length))}</span>${[
            format(strings.columns, columns.length),
            ...truncated,
            ...credentialPart,
        ]
            .map((part: string) => ` · ${escapeHtml(part)}`)
            .join("")}</span>
    </div>
    <div class="table-shell">
      <table id="dataTable">
        <colgroup>${columns.map(() => "<col>").join("")}</colgroup>
        <thead><tr>${header}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <div class="detail" id="detail">
      <div class="detail-bar">
        <label for="detailColumn">${escapeHtml(strings.detailColumn)}</label>
        <select id="detailColumn">${detailOptions}</select>
        <span class="detail-row-label" id="detailRowLabel"></span>
      </div>
      <div class="detail-value" id="detailValue"><div class="detail-empty">${escapeHtml(strings.detailHint)}</div></div>
    </div>`;
}

/** Acima deste tamanho a célula ganha clique-para-expandir e tooltip. */
const EXPANDABLE_THRESHOLD: number = 60;
const TITLE_MAX: number = 400;

function renderCell(value: unknown): string {
    const className: string = cellClass(value);
    const text: string = formatCell(value);
    const long: boolean = text.length > EXPANDABLE_THRESHOLD || text.includes("\n");

    // Tooltip dá uma espiada rápida; o valor completo fica no painel de detalhe.
    const title: string = long
        ? ` title="${escapeHtml(text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text)}"`
        : "";

    return `<td class="${className}"><div class="cell"${title}>${escapeHtml(text)}</div></td>`;
}

function cellClass(value: unknown): string {
    if (value === null || value === undefined) {
        return "cell-null";
    }

    if (typeof value === "number") {
        return "cell-number";
    }

    if (typeof value === "boolean") {
        return "cell-boolean";
    }

    if (typeof value === "object") {
        return "cell-object";
    }

    return "cell-text";
}

function formatCell(value: unknown): string {
    if (value === null || value === undefined) {
        return "null";
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    return String(value);
}

function isRowArray(value: unknown): value is ReadonlyArray<Record<string, unknown>> {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item: unknown) => typeof item === "object" && item !== null && !Array.isArray(item))
    );
}

/**
 * O PQTest embrulha o resultado num envelope `[{ ActivityId, Status, Output: [...] }]`.
 * Os dados de verdade ficam na chave "Output" — então procuramos ela primeiro, senão
 * o envelope inteiro (array de 1 objeto) acabaria virando a "tabela".
 */
function findArrayByKey(node: unknown, key: string): RowsResult | undefined {
    if (node === null || typeof node !== "object") {
        return undefined;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            const found: RowsResult | undefined = findArrayByKey(item, key);

            if (found !== undefined) {
                return found;
            }
        }

        return undefined;
    }

    const record = node as Record<string, unknown>;

    if (isRowArray(record[key])) {
        return { rows: record[key] as ReadonlyArray<Record<string, unknown>>, path: key };
    }

    for (const value of Object.values(record)) {
        const found: RowsResult | undefined = findArrayByKey(value, key);

        if (found !== undefined) {
            return found;
        }
    }

    return undefined;
}

/** Fallback genérico: primeiro array de objetos encontrado (para JSON que não é do PQTest). */
function findFirstObjectArray(parsed: unknown, path: string = "$"): RowsResult | undefined {
    if (isRowArray(parsed)) {
        return { rows: parsed, path };
    }

    if (typeof parsed === "object" && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
            const rows: RowsResult | undefined = findFirstObjectArray(value, `${path}.${key}`);

            if (rows !== undefined) {
                return rows;
            }
        }
    }

    return undefined;
}

function findRows(parsed: unknown): RowsResult | undefined {
    return findArrayByKey(parsed, "Output") ?? findFirstObjectArray(parsed);
}

/** Coluna mostrada por padrão no painel de baixo: "Output" se existir, senão a de maior conteúdo. */
function chooseDetailColumn(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): number {
    const named: number = columns.findIndex((c: string) => c.trim().toLowerCase() === "output");

    if (named !== -1) {
        return named;
    }

    let bestIndex: number = 0;
    let bestLength: number = -1;

    columns.forEach((column: string, index: number) => {
        let total: number = 0;

        for (const row of rows) {
            total += formatCell(row[column]).length;
        }

        if (total > bestLength) {
            bestLength = total;
            bestIndex = index;
        }
    });

    return bestIndex;
}
