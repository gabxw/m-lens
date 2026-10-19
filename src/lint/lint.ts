/**
 * Linter de Power Query M baseado em AST (@microsoft/powerquery-parser).
 * Módulo puro — não importa "vscode" para poder ser testado em Node puro.
 */
import * as PQP from "@microsoft/powerquery-parser";

import { Ast } from "@microsoft/powerquery-parser/lib/powerquery-parser/language";

export type RuleId =
    | "unused-step"
    | "table-buffer"
    | "hardcoded-path"
    | "generic-step-name"
    | "sensitive-literal"
    | "localhost-source"
    | "web-contents-options"
    | "remove-columns-risk"
    | "parse-error";

export interface LintPosition {
    /** 0-based */
    readonly line: number;
    /** 0-based */
    readonly character: number;
}

export interface LintRange {
    readonly start: LintPosition;
    readonly end: LintPosition;
}

export interface LintFinding {
    readonly ruleId: RuleId;
    /** Mensagem padrão em inglês; a extensão traduz por ruleId + args (diagnostics.ts). */
    readonly message: string;
    /** Valores interpolados na mensagem (ex.: nome do step). */
    readonly args?: readonly string[];
    readonly range: LintRange;
    /** Para quick fix de remoção (unused-step): intervalo de texto a apagar. */
    readonly removalRange?: LintRange;
}

function toRange(tokenRange: { positionStart: PositionLike; positionEnd: PositionLike }): LintRange {
    return {
        start: { line: tokenRange.positionStart.lineNumber, character: tokenRange.positionStart.lineCodeUnit },
        end: { line: tokenRange.positionEnd.lineNumber, character: tokenRange.positionEnd.lineCodeUnit },
    };
}

interface PositionLike {
    readonly lineNumber: number;
    readonly lineCodeUnit: number;
}

/** Visita recursivamente todos os nós da AST. */
export function walkAst(node: unknown, visit: (node: Ast.TNode) => void): void {
    if (Array.isArray(node)) {
        for (const item of node) {
            walkAst(item, visit);
        }

        return;
    }

    if (typeof node !== "object" || node === null) {
        return;
    }

    const candidate = node as { kind?: unknown; tokenRange?: unknown; id?: unknown };

    const isAstNode =
        typeof candidate.kind === "string" && candidate.tokenRange !== undefined && typeof candidate.id === "number";

    if (isAstNode) {
        visit(node as Ast.TNode);
    }

    for (const [key, value] of Object.entries(node)) {
        if (key === "tokenRange") {
            continue;
        }

        walkAst(value, visit);
    }
}

/** Remove a forma #"Nome" -> Nome (com unescape de "") para comparar identificadores. */
export function normalizeIdentifier(literal: string): string {
    if (literal.startsWith('#"') && literal.endsWith('"')) {
        return literal.slice(2, -1).replace(/""/g, '"');
    }

    return literal;
}

const BUFFER_FUNCTIONS: ReadonlySet<string> = new Set(["Table.Buffer", "List.Buffer", "Binary.Buffer"]);

/** Nomes de step gerados automaticamente pela UI do Power Query, com sufixo numérico. */
const GENERIC_STEP_NAME: RegExp = new RegExp(
    "^(" +
        [
            // Power Query em inglês
            "Custom", "Source", "Table", "Navigation", "Renamed Columns", "Added Custom", "Changed Type",
            "Filtered Rows", "Removed Columns", "Removed Other Columns", "Merged Queries", "Appended Query",
            String.raw`Expanded [\p{L}\w ]+`, "Grouped Rows", "Sorted Rows", "Replaced Value", "Promoted Headers",
            "Removed Duplicates", "Reordered Columns",
            // Power Query em português
            "Fonte", "Personalizar", "Personalizado", "Personalização Adicionada", "Navegação", "Tipo Alterado",
            "Tipo Alterado com Localidade", "Colunas Renomeadas", "Linhas Filtradas", "Colunas Removidas",
            "Outras Colunas Removidas", "Consultas Mescladas", "Consulta Acrescentada", "Linhas Agrupadas",
            "Linhas Classificadas", "Valor Substituído", "Cabeçalhos Promovidos", "Duplicatas Removidas",
            "Colunas Reordenadas", String.raw`[\p{L}\w ]+ Expandido`,
        ].join("|") +
        String.raw`)\s*\d+$`,
    "u",
);

/** Arquivo de parâmetro (`"valor" meta [IsParameterQuery=true, ...]`): o literal É a configuração. */
const PARAMETER_QUERY: RegExp = /\bmeta\s*\[[^\]]*IsParameterQuery\s*=\s*true/i;

/** Literal de texto começando com unidade de disco (C:\) ou UNC (\\servidor). */
const HARDCODED_PATH: RegExp = /^"(?:[A-Za-z]:[\\/]|\\\\)/;
const LOCALHOST_SOURCE: RegExp = /^"https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|")/i;
/**
 * Segredo dentro de um literal: par chave=valor (connection string, query string),
 * Bearer token ou formatos conhecidos de chave. Só o nome ("Password Reset Date",
 * "token_id", "Secretaria") não basta — isso é nome de coluna, não segredo.
 */
const SENSITIVE_LITERAL: RegExp = new RegExp(
    [
        String.raw`\b(?:password|passwd|pwd|senha|secret|client[_-]?secret|api[_-]?key|access[_-]?token|token)\s*[=:]\s*[^\s;&"]{3,}`,
        String.raw`\bbearer\s+[A-Za-z0-9._~+/=-]{6,}`,
        String.raw`\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}`,
        String.raw`\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,})`,
    ].join("|"),
    "i",
);

/**
 * Troca o conteúdo de comentários M (`//` e `/* *\/`) por espaços, preservando
 * posições e quebras de linha. Textos ("...", #"...") ficam intactos — inclusive
 * um "http://" dentro de string, que não é comentário.
 */
export function maskComments(text: string): string {
    const chars: string[] = text.split("");
    let i: number = 0;

    while (i < chars.length) {
        const ch: string = chars[i];
        const next: string | undefined = chars[i + 1];

        if (ch === '"') {
            i += 1;

            while (i < chars.length) {
                if (chars[i] === '"' && chars[i + 1] === '"') {
                    i += 2;
                } else if (chars[i] === '"') {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }

            continue;
        }

        if (ch === "/" && next === "/") {
            while (i < chars.length && chars[i] !== "\n" && chars[i] !== "\r") {
                chars[i] = " ";
                i += 1;
            }

            continue;
        }

        if (ch === "/" && next === "*") {
            while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) {
                if (chars[i] !== "\n" && chars[i] !== "\r") {
                    chars[i] = " ";
                }

                i += 1;
            }

            if (i < chars.length) {
                chars[i] = " ";
                chars[i + 1] = " ";
                i += 2;
            }

            continue;
        }

        i += 1;
    }

    return chars.join("");
}

function linePatternFinding(
    text: string,
    pattern: RegExp,
    ruleId: RuleId,
    message: string,
): LintFinding[] {
    const findings: LintFinding[] = [];
    const lines: string[] = maskComments(text).split(/\r?\n/);

    lines.forEach((line: string, lineIndex: number) => {
        const match: RegExpMatchArray | null = line.match(pattern);

        if (match === null || match.index === undefined) {
            return;
        }

        const matchedText: string = match[0];

        findings.push({
            ruleId,
            message,
            range: {
                start: { line: lineIndex, character: match.index },
                end: { line: lineIndex, character: match.index + matchedText.length },
            },
        });
    });

    return findings;
}

export async function lintDocument(text: string): Promise<ReadonlyArray<LintFinding>> {
    const task: PQP.Task.TriedLexParseTask = await PQP.TaskUtils.tryLexParse(PQP.DefaultSettings, text);

    if (!PQP.TaskUtils.isParseStageOk(task)) {
        // Erros de sintaxe já são reportados pela extensão oficial — não duplicamos.
        return [];
    }

    const findings: LintFinding[] = [];
    const isParameter: boolean = PARAMETER_QUERY.test(maskComments(text));

    walkAst(task.ast, (node: Ast.TNode) => {
        switch (node.kind) {
            case Ast.NodeKind.LetExpression:
                findings.push(...lintLetExpression(node));
                break;

            case Ast.NodeKind.IdentifierExpression:
                findings.push(...lintIdentifierExpression(node));
                break;

            case Ast.NodeKind.LiteralExpression:
                findings.push(...lintLiteralExpression(node, isParameter));
                break;

            default:
                break;
        }
    });

    findings.push(...lintTextPatterns(text));

    return findings;
}

function lintTextPatterns(text: string): LintFinding[] {
    return [
        ...linePatternFinding(
            text,
            /Web\.Contents\s*\(\s*"[^"]+\?[^"]*"/,
            "web-contents-options",
            "Web.Contents with a hardcoded query string. Use the RelativePath and Query options so credentials, caching and scheduled refresh work reliably.",
        ),
        ...linePatternFinding(
            text,
            /\bTable\.RemoveColumns\s*\(/,
            "remove-columns-risk",
            "Table.RemoveColumns lets new source columns flow through silently. If you know the final columns, Table.SelectColumns is more explicit.",
        ),
    ];
}

function lintLetExpression(letNode: Ast.LetExpression): LintFinding[] {
    const findings: LintFinding[] = [];
    const entries: ReadonlyArray<Ast.ICsv<Ast.IdentifierPairedExpression>> = letNode.variableList.elements;

    // Identificadores referenciados nos valores dos steps e na expressão do `in`.
    const used: Set<string> = new Set();

    const collectUsages = (root: unknown): void => {
        walkAst(root, (node: Ast.TNode) => {
            if (node.kind === Ast.NodeKind.IdentifierExpression) {
                used.add(normalizeIdentifier(node.identifier.literal));
            }
        });
    };

    for (const entry of entries) {
        collectUsages(entry.node.value);
    }

    collectUsages(letNode.expression);

    entries.forEach((entry: Ast.ICsv<Ast.IdentifierPairedExpression>, index: number) => {
        const identifier: Ast.Identifier = entry.node.key;
        const name: string = normalizeIdentifier(identifier.literal);

        if (!used.has(name)) {
            findings.push({
                ruleId: "unused-step",
                message: `Step "${name}" is declared but never used.`,
                args: [name],
                range: toRange(identifier.tokenRange),
                removalRange: computeRemovalRange(entries, index),
            });
        }

        if (GENERIC_STEP_NAME.test(name)) {
            findings.push({
                ruleId: "generic-step-name",
                message: `"${name}" is a generic step name. A descriptive name makes the query easier to follow.`,
                args: [name],
                range: toRange(identifier.tokenRange),
            });
        }
    });

    return findings;
}

function computeRemovalRange(
    entries: ReadonlyArray<Ast.ICsv<Ast.IdentifierPairedExpression>>,
    index: number,
): LintRange | undefined {
    const entry: Ast.ICsv<Ast.IdentifierPairedExpression> = entries[index];

    if (entry.commaConstant !== undefined) {
        // Elemento com vírgula: o tokenRange do Csv cobre nó + vírgula.
        return toRange(entry.tokenRange);
    }

    if (index > 0) {
        // Último elemento: remove também a vírgula do elemento anterior.
        const previous: Ast.ICsv<Ast.IdentifierPairedExpression> = entries[index - 1];

        return {
            start: toRange(previous.node.tokenRange).end,
            end: toRange(entry.tokenRange).end,
        };
    }

    // Único step do let — remover deixaria o código inválido.
    return undefined;
}

function lintIdentifierExpression(node: Ast.IdentifierExpression): LintFinding[] {
    const name: string = node.identifier.literal;

    if (BUFFER_FUNCTIONS.has(name)) {
        return [
            {
                ruleId: "table-buffer",
                message: `${name} loads the data into memory and stops query folding from this step on. Make sure that is intended.`,
                args: [name],
                range: toRange(node.tokenRange),
            },
        ];
    }

    return [];
}

function lintLiteralExpression(node: Ast.LiteralExpression, isParameter: boolean): LintFinding[] {
    const findings: LintFinding[] = [];

    // Em arquivo de parâmetro o caminho/host É a configuração recomendada — não apontar.
    if (!isParameter && node.literalKind === Ast.LiteralKind.Text && HARDCODED_PATH.test(node.literal)) {
        findings.push({
            ruleId: "hardcoded-path",
            message:
                "Hardcoded file path. It breaks when someone else refreshes the report; move it to a parameter.",
            range: toRange(node.tokenRange),
        });
    }

    if (!isParameter && node.literalKind === Ast.LiteralKind.Text && LOCALHOST_SOURCE.test(node.literal)) {
        findings.push({
            ruleId: "localhost-source",
            message: "Source points to localhost, which usually fails in the Power BI Service or on another machine.",
            range: toRange(node.tokenRange),
        });
    }

    if (node.literalKind === Ast.LiteralKind.Text && SENSITIVE_LITERAL.test(node.literal)) {
        findings.push({
            ruleId: "sensitive-literal",
            message:
                "Possible secret in the query text. Use Power Query credentials or a parameter instead of hardcoding it.",
            range: toRange(node.tokenRange),
        });
    }

    return findings;
}
