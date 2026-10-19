/** Análise do workspace: queries, fontes de dados, possíveis segredos e dependências. */
import * as path from "path";
import * as vscode from "vscode";

import { LintFinding, lintDocument, maskComments } from "../lint/lint";
import { countPendingPbipChanges, readExtractionMap } from "../pbip/tmdl";
import { findPqTest } from "../preview/evaluator";
import { showReadOnlyMarkdown } from "../util/markdown";

export interface QueryFileInfo {
    readonly uri: vscode.Uri;
    readonly relativePath: string;
    readonly name: string;
    readonly text: string;
}

export interface DataSourceFinding {
    readonly uri: vscode.Uri;
    readonly file: string;
    /** 1-based */
    readonly line: number;
    readonly functionName: string;
    readonly detail: string;
}

export interface SensitiveFinding {
    readonly uri: vscode.Uri;
    readonly file: string;
    /** 1-based */
    readonly line: number;
}

export interface QueryDependency {
    readonly query: string;
    readonly uri: vscode.Uri;
    readonly file: string;
    readonly dependsOn: string[];
}

export interface WorkspaceReport {
    readonly workspaceName: string;
    readonly queryFiles: QueryFileInfo[];
    readonly tmdlCount: number;
    readonly pbipFiles: string[];
    readonly pbixFiles: vscode.Uri[];
    /** Queries no mapa de extração PBIP (0 = ainda não extraído). */
    readonly extractedCount: number;
    /** Queries editadas nos .pq e ainda não aplicadas ao PBIP. */
    readonly pendingChanges: number;
    readonly pqTestPath: string | undefined;
    readonly dataSources: DataSourceFinding[];
    readonly sensitiveFindings: SensitiveFinding[];
    readonly dependencies: QueryDependency[];
}

const EXCLUDE: string = "**/{node_modules,.mlens,.git}/**";

const SOURCE_FUNCTIONS: readonly string[] = [
    "File.Contents",
    "Folder.Files",
    "Folder.Contents",
    "Csv.Document",
    "Excel.Workbook",
    "Json.Document",
    "Xml.Tables",
    "Web.Contents",
    "OData.Feed",
    "SharePoint.Files",
    "SharePoint.Contents",
    "SharePoint.Tables",
    "Sql.Database",
    "Sql.Databases",
    "AnalysisServices.Database",
    "PostgreSQL.Database",
    "MySQL.Database",
    "Oracle.Database",
    "Odbc.DataSource",
    "Snowflake.Databases",
    "Databricks.Catalogs",
    "GoogleBigQuery.Database",
    "PowerPlatform.Dataflows",
    "CommonDataService.Database",
];

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relativePath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
    return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
}

async function readText(uri: vscode.Uri): Promise<string> {
    const bytes: Uint8Array = await vscode.workspace.fs.readFile(uri);

    return Buffer.from(bytes).toString("utf8");
}

function extractTextLiterals(text: string): string[] {
    const values: string[] = [];
    const literalPattern: RegExp = /"((?:""|[^"])*)"/g;
    let match: RegExpExecArray | null;

    while ((match = literalPattern.exec(text)) !== null) {
        values.push(match[1].replace(/""/g, '"'));
    }

    return values;
}

function scanDataSources(file: QueryFileInfo): DataSourceFinding[] {
    const findings: DataSourceFinding[] = [];
    const lines: string[] = maskComments(file.text).split(/\r?\n/);

    lines.forEach((line: string, index: number) => {
        for (const functionName of SOURCE_FUNCTIONS) {
            const regex: RegExp = new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(([^\\n]*)`, "g");
            let match: RegExpExecArray | null;

            while ((match = regex.exec(line)) !== null) {
                const literals: string[] = extractTextLiterals(match[1]);

                findings.push({
                    uri: file.uri,
                    file: file.relativePath,
                    line: index + 1,
                    functionName,
                    detail: literals.length > 0 ? literals.join(", ") : vscode.l10n.t("(no literal, uses a parameter or step)"),
                });
            }
        }
    });

    return findings;
}

async function scanSensitiveValues(file: QueryFileInfo): Promise<SensitiveFinding[]> {
    const findings: ReadonlyArray<LintFinding> = await lintDocument(file.text);

    // Só a localização: o relatório não repete o segredo.
    return findings
        .filter((finding: LintFinding) => finding.ruleId === "sensitive-literal")
        .map((finding: LintFinding) => ({ uri: file.uri, file: file.relativePath, line: finding.range.start.line + 1 }));
}

/**
 * Query A depende de B quando o código de A cita B (`B` ou `#"B"`). M diferencia
 * maiúsculas; e se A declara um step com o mesmo nome, a referência é ao step, não à query.
 */
function scanDependencies(files: readonly QueryFileInfo[]): QueryDependency[] {
    return files
        .map((file: QueryFileInfo) => {
            const code: string = maskComments(file.text);
            const dependsOn: string[] = [];

            for (const candidate of files) {
                if (candidate.relativePath === file.relativePath) {
                    continue;
                }

                const quoted: string = `#"${candidate.name.replace(/"/g, '""')}"`;
                const bare: string | undefined = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(candidate.name) ? candidate.name : undefined;
                const reference: RegExp = new RegExp(
                    [escapeRegExp(quoted), ...(bare !== undefined ? [`(?<![\\w.#"])${escapeRegExp(bare)}(?![\\w.])`] : [])].join("|"),
                );
                const localStep: RegExp = new RegExp(
                    `(?:^|[\\s,])(?:${[escapeRegExp(quoted), ...(bare !== undefined ? [escapeRegExp(bare)] : [])].join("|")})\\s*=(?!=)`,
                    "m",
                );

                if (reference.test(code) && !localStep.test(code)) {
                    dependsOn.push(candidate.name);
                }
            }

            return {
                query: file.name,
                uri: file.uri,
                file: file.relativePath,
                dependsOn: dependsOn.sort((a: string, b: string) => a.localeCompare(b)),
            };
        })
        .filter((item: QueryDependency) => item.dependsOn.length > 0)
        .sort((a: QueryDependency, b: QueryDependency) => a.query.localeCompare(b.query));
}

export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
}

export async function analyzeWorkspace(): Promise<WorkspaceReport | undefined> {
    const folder: vscode.WorkspaceFolder | undefined = getWorkspaceFolder();

    if (folder === undefined) {
        return undefined;
    }

    const includeM: boolean = vscode.workspace.getConfiguration("mlens").get<boolean>("files.lintMFiles", true);

    const [queryUris, tmdlUris, pbipUris, pbixUris, pqTestPath] = await Promise.all([
        vscode.workspace.findFiles(includeM ? "**/*.{pq,m}" : "**/*.pq", EXCLUDE),
        vscode.workspace.findFiles("**/*.tmdl", EXCLUDE),
        vscode.workspace.findFiles("**/*.pbip", EXCLUDE),
        vscode.workspace.findFiles("**/*.{pbix,pbit}", EXCLUDE),
        findPqTest(),
    ]);

    const queryFiles: QueryFileInfo[] = [];

    for (const uri of queryUris) {
        queryFiles.push({
            uri,
            relativePath: relativePath(folder, uri),
            name: path.basename(uri.fsPath, path.extname(uri.fsPath)),
            text: await readText(uri),
        });
    }

    queryFiles.sort((a: QueryFileInfo, b: QueryFileInfo) => a.relativePath.localeCompare(b.relativePath));

    const sensitiveFindings: SensitiveFinding[] = [];

    for (const file of queryFiles) {
        sensitiveFindings.push(...(await scanSensitiveValues(file)));
    }

    const map = await readExtractionMap(folder);

    return {
        workspaceName: folder.name,
        queryFiles,
        tmdlCount: tmdlUris.length,
        pbipFiles: pbipUris.map((uri: vscode.Uri) => relativePath(folder, uri)).sort(),
        pbixFiles: pbixUris,
        extractedCount: map?.length ?? 0,
        pendingChanges: map === undefined ? 0 : await countPendingPbipChanges(folder, map),
        pqTestPath,
        dataSources: queryFiles.flatMap(scanDataSources),
        sensitiveFindings,
        dependencies: scanDependencies(queryFiles),
    };
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    if (rows.length === 0) {
        return `_${vscode.l10n.t("Nothing found.")}_`;
    }

    const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    const header: string = `| ${headers.map(cell).join(" | ")} |`;
    const separator: string = `| ${headers.map(() => "---").join(" | ")} |`;
    const body: string = rows.map((row: readonly string[]) => `| ${row.map(cell).join(" | ")} |`).join("\n");

    return `${header}\n${separator}\n${body}`;
}

function fileLink(uri: vscode.Uri, label: string, line?: number): string {
    const target: string = line === undefined ? uri.toString() : `${uri.toString()}#L${line}`;

    return `[${label.replace(/[[\]]/g, "")}](${target})`;
}

export function renderWorkspaceReportMarkdown(report: WorkspaceReport): string {
    const yes: string = vscode.l10n.t("Yes");
    const no: string = vscode.l10n.t("No");

    const summary: string[][] = [
        [vscode.l10n.t("Power Query files (.pq/.m)"), String(report.queryFiles.length)],
        [vscode.l10n.t("PBIP projects"), report.pbipFiles.length > 0 ? report.pbipFiles.join(", ") : no],
        [vscode.l10n.t("TMDL files"), String(report.tmdlCount)],
        [vscode.l10n.t("Queries extracted from PBIP"), String(report.extractedCount)],
        [vscode.l10n.t("Edited queries not applied yet"), String(report.pendingChanges)],
        [vscode.l10n.t("Data preview (PQTest.exe)"), report.pqTestPath !== undefined ? yes : no],
        [vscode.l10n.t("Data sources"), String(report.dataSources.length)],
        [vscode.l10n.t("Possible secrets"), String(report.sensitiveFindings.length)],
    ];

    const steps: string[] = [];

    if (report.pbipFiles.length > 0 && report.extractedCount === 0) {
        steps.push(vscode.l10n.t("Run **M Lens: Extract Queries from PBIP** to edit the queries as .pq files."));
    }

    if (report.pendingChanges > 0) {
        steps.push(vscode.l10n.t("Run **M Lens: Review PBIP Changes**, then **M Lens: Apply Queries to PBIP**."));
    }

    if (report.sensitiveFindings.length > 0) {
        steps.push(vscode.l10n.t("Move possible secrets out of the query text before you share or commit the project."));
    }

    if (report.dataSources.some((source: DataSourceFinding) => /^[A-Za-z]:[\\/]|^\\\\/.test(source.detail))) {
        steps.push(vscode.l10n.t("Local file paths only work on your machine; use a parameter or a SharePoint/OneDrive location before publishing."));
    }

    return [
        `# ${vscode.l10n.t("M Lens workspace report: {0}", report.workspaceName)}`,
        "",
        markdownTable([vscode.l10n.t("Item"), vscode.l10n.t("Value")], summary),
        "",
        ...(steps.length > 0 ? [`## ${vscode.l10n.t("Suggested next steps")}`, "", ...steps.map((step: string) => `- ${step}`), ""] : []),
        `## ${vscode.l10n.t("Data sources")}`,
        "",
        markdownTable(
            [vscode.l10n.t("Function"), vscode.l10n.t("Target"), vscode.l10n.t("Location")],
            report.dataSources.map((source: DataSourceFinding) => [
                `\`${source.functionName}\``,
                source.detail,
                fileLink(source.uri, `${source.file}:${source.line}`, source.line),
            ]),
        ),
        "",
        `## ${vscode.l10n.t("Possible secrets")}`,
        "",
        markdownTable(
            [vscode.l10n.t("Location")],
            report.sensitiveFindings.map((finding: SensitiveFinding) => [
                fileLink(finding.uri, `${finding.file}:${finding.line}`, finding.line),
            ]),
        ),
        "",
        `## ${vscode.l10n.t("Query dependencies")}`,
        "",
        markdownTable(
            [vscode.l10n.t("Query"), vscode.l10n.t("Depends on")],
            report.dependencies.map((dependency: QueryDependency) => [
                fileLink(dependency.uri, dependency.query),
                dependency.dependsOn.join(", "),
            ]),
        ),
        "",
        `_${vscode.l10n.t("Dependencies are matched by file name, so they are a best-effort map.")}_`,
        "",
    ].join("\n");
}

export async function showWorkspaceReport(): Promise<void> {
    if (getWorkspaceFolder() === undefined) {
        void vscode.window.showWarningMessage(vscode.l10n.t("M Lens: open a folder first."));

        return;
    }

    const report: WorkspaceReport | undefined = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: vscode.l10n.t("M Lens: analyzing workspace") },
        () => analyzeWorkspace(),
    );

    if (report !== undefined) {
        await showReadOnlyMarkdown("workspace-report", renderWorkspaceReportMarkdown(report));
    }
}
