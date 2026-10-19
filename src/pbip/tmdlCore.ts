/**
 * Lógica pura de extração/reaplicação de M em TMDL — sem dependência do VS Code,
 * para permitir teste em Node puro.
 *
 * Blocos suportados:
 *   - `source =` dentro de `partition <nome> = m` (tabelas importadas)
 *   - `expression <nome> = ...` (queries/parâmetros compartilhados em expressions.tmdl)
 */

export interface ExtractedBlock {
    readonly name: string;
    readonly kind: "partition-source" | "expression";
    /** Código M com a indentação base removida. */
    readonly code: string;
    /** Índice (0-based) da linha do cabeçalho (`source =` / `expression X =`). */
    readonly headerLine: number;
    /** Índice da última linha do código M (inclusive). Metadados TMDL depois dele ficam fora. */
    readonly endLine: number;
    /** Indentação da linha do cabeçalho. */
    readonly headerIndent: string;
    /** Cabeçalho original até o `=` (inclusive), preservado na reaplicação. */
    readonly headerPrefix: string;
    /** O código começava na mesma linha do cabeçalho (ex.: parâmetros). */
    readonly inline: boolean;
}

const PARTITION_HEADER: RegExp = /^\s*partition\s+(.+?)\s*=\s*m\s*$/;
const SOURCE_HEADER: RegExp = /^((\s*)source\s*=)\s*(.*)$/;
const EXPRESSION_HEADER: RegExp = /^((\s*)expression\s+(.+?)\s*=)\s*(.*)$/;

function unquoteName(raw: string): string {
    const trimmed: string = raw.trim();

    if (
        (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
        return trimmed.slice(1, -1);
    }

    return trimmed;
}

function indentWidth(indent: string): number {
    // Tab conta como 4 para fins de comparação de profundidade.
    let width: number = 0;

    for (const ch of indent) {
        width += ch === "\t" ? 4 : 1;
    }

    return width;
}

function leadingIndent(line: string): string {
    const match: RegExpMatchArray | null = line.match(/^[\t ]*/);

    return match !== null ? match[0] : "";
}

/** Largura de um nível de indentação no arquivo (tab = 4, ou o menor recuo com espaços). */
function indentUnitOf(text: string): string {
    return text.includes("\t") ? "\t" : "    ";
}

/**
 * Coleta as linhas do código M de um bloco e devolve o índice da última linha de código.
 *
 * O corpo M fica um nível abaixo das propriedades do objeto (`lineageTag:`, `queryGroup:`,
 * `annotation`...), que por sua vez ficam um nível abaixo do cabeçalho. Por isso a primeira
 * linha não vazia define a indentação do corpo, e o código termina na primeira linha menos
 * indentada que ela — o que vier depois são metadados TMDL e não pertencem ao M.
 * Linhas em branco no fim do corpo ficam fora do bloco.
 */
function collectCode(
    lines: ReadonlyArray<string>,
    headerLine: number,
    headerIndent: string,
    hasInline: boolean,
    indentUnit: string,
): number {
    const headerWidth: number = indentWidth(headerIndent);
    let bodyWidth: number | undefined = hasInline ? headerWidth + 2 * indentWidth(indentUnit) : undefined;
    let end: number = headerLine;

    for (let i: number = headerLine + 1; i < lines.length; i += 1) {
        const line: string = lines[i];

        if (line.trim() === "") {
            continue;
        }

        const width: number = indentWidth(leadingIndent(line));

        if (bodyWidth === undefined) {
            if (width <= headerWidth) {
                break;
            }

            bodyWidth = width;
        }

        if (width < bodyWidth) {
            break;
        }

        end = i;
    }

    return end;
}

/** Remove a menor indentação comum das linhas do bloco. */
function dedent(lines: ReadonlyArray<string>): string {
    const nonEmpty: ReadonlyArray<string> = lines.filter((l: string) => l.trim() !== "");

    if (nonEmpty.length === 0) {
        return "";
    }

    const minWidth: number = Math.min(...nonEmpty.map((l: string) => indentWidth(leadingIndent(l))));

    const result: string[] = lines.map((line: string) => {
        if (line.trim() === "") {
            return "";
        }

        let width: number = 0;
        let index: number = 0;

        while (index < line.length && width < minWidth) {
            width += line[index] === "\t" ? 4 : 1;
            index += 1;
        }

        return line.slice(index);
    });

    return result.join("\n");
}

/** Normaliza o código para comparação: só LF e sem espaços no fim. */
export function normalizeCode(code: string): string {
    return code.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

export function extractBlocks(tmdlText: string): ExtractedBlock[] {
    const lines: string[] = tmdlText.split(/\r?\n/);
    const indentUnit: string = indentUnitOf(tmdlText);
    const blocks: ExtractedBlock[] = [];

    let pendingPartition: string | undefined;
    let pendingPartitionIndent: number = 0;

    const pushBlock = (
        name: string,
        kind: ExtractedBlock["kind"],
        headerLine: number,
        headerPrefix: string,
        headerIndent: string,
        inline: string,
    ): number => {
        const end: number = collectCode(lines, headerLine, headerIndent, inline !== "", indentUnit);
        const body: string = dedent(lines.slice(headerLine + 1, end + 1));

        blocks.push({
            name,
            kind,
            code: normalizeCode([inline, body].filter(Boolean).join("\n")),
            headerLine,
            endLine: end,
            headerIndent,
            headerPrefix,
            inline: inline !== "",
        });

        return end;
    };

    for (let i: number = 0; i < lines.length; i += 1) {
        const line: string = lines[i];

        const partitionMatch: RegExpMatchArray | null = line.match(PARTITION_HEADER);

        if (partitionMatch !== null) {
            pendingPartition = unquoteName(partitionMatch[1]);
            pendingPartitionIndent = indentWidth(leadingIndent(line));
            continue;
        }

        if (pendingPartition !== undefined) {
            const indent: number = indentWidth(leadingIndent(line));

            if (line.trim() !== "" && indent <= pendingPartitionIndent) {
                // Saiu do corpo da partition sem achar `source =`.
                pendingPartition = undefined;
            } else {
                const sourceMatch: RegExpMatchArray | null = line.match(SOURCE_HEADER);

                if (sourceMatch !== null) {
                    i = pushBlock(pendingPartition, "partition-source", i, sourceMatch[1], sourceMatch[2], sourceMatch[3].trim());
                    pendingPartition = undefined;
                }
            }

            continue;
        }

        const expressionMatch: RegExpMatchArray | null = line.match(EXPRESSION_HEADER);

        if (expressionMatch !== null) {
            i = pushBlock(
                unquoteName(expressionMatch[3]),
                "expression",
                i,
                expressionMatch[1],
                expressionMatch[2],
                expressionMatch[4].trim(),
            );
        }
    }

    return blocks;
}

export function formatTmdlName(name: string): string {
    // Nomes com espaço ou caracteres especiais precisam de aspas simples no TMDL.
    return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name}'`;
}

/**
 * Substitui o código M do bloco `name`/`kind` em `tmdlText`, preservando cabeçalho,
 * metadados TMDL (`lineageTag`, `queryGroup`, `annotation`...) e quebras de linha do arquivo.
 * Se o código não mudou, devolve o texto original intacto.
 * Retorna undefined se o bloco não for encontrado.
 */
export function applyBlockToText(
    tmdlText: string,
    name: string,
    kind: ExtractedBlock["kind"],
    code: string,
): string | undefined {
    const blocks: ExtractedBlock[] = extractBlocks(tmdlText);
    const target: ExtractedBlock | undefined = blocks.find(
        (b: ExtractedBlock) => b.name === name && b.kind === kind,
    );

    if (target === undefined) {
        return undefined;
    }

    const newCode: string = normalizeCode(code);

    if (newCode === target.code) {
        return tmdlText;
    }

    const eol: string = tmdlText.includes("\r\n") ? "\r\n" : "\n";
    const lines: string[] = tmdlText.split(/\r?\n/);
    const indentUnit: string = indentUnitOf(tmdlText);
    const bodyIndent: string = target.headerIndent + indentUnit + indentUnit;
    const codeLines: string[] = newCode.split("\n");

    // Parâmetros e expressões de uma linha continuam na linha do cabeçalho.
    const newBlock: string[] =
        target.inline && codeLines.length === 1
            ? [`${target.headerPrefix} ${codeLines[0]}`]
            : [target.headerPrefix, ...codeLines.map((l: string) => (l === "" ? "" : bodyIndent + l))];

    lines.splice(target.headerLine, target.endLine - target.headerLine + 1, ...newBlock);

    return lines.join(eol);
}
