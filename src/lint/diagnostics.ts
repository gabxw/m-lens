/** Integração do linter com o VS Code: diagnostics, severidades configuráveis e quick fixes. */
import * as path from "path";
import * as vscode from "vscode";

import { isPowerQueryLikeDocument } from "../util/editor";
import { LintFinding, lintDocument, RuleId } from "./lint";

const SOURCE: string = "M Lens";
const DEBOUNCE_MS: number = 400;

type SeveritySetting = "off" | "hint" | "info" | "warning" | "error";

const RULE_SETTING: Record<Exclude<RuleId, "parse-error">, string> = {
    "unused-step": "lint.unusedStep",
    "table-buffer": "lint.tableBuffer",
    "hardcoded-path": "lint.hardcodedPath",
    "generic-step-name": "lint.genericStepName",
    "sensitive-literal": "lint.sensitiveLiteral",
    "localhost-source": "lint.localhostSource",
    "web-contents-options": "lint.webContentsOptions",
    "remove-columns-risk": "lint.removeColumnsRisk",
};

function severityFor(ruleId: RuleId): vscode.DiagnosticSeverity | undefined {
    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("mlens");
    const settingKey: string | undefined = RULE_SETTING[ruleId as Exclude<RuleId, "parse-error">];

    if (settingKey === undefined) {
        return vscode.DiagnosticSeverity.Error;
    }

    const value: SeveritySetting = config.get<SeveritySetting>(settingKey, "warning");

    switch (value) {
        case "off":
            return undefined;
        case "hint":
            return vscode.DiagnosticSeverity.Hint;
        case "info":
            return vscode.DiagnosticSeverity.Information;
        case "warning":
            return vscode.DiagnosticSeverity.Warning;
        case "error":
            return vscode.DiagnosticSeverity.Error;
    }
}

/** O linter é puro (sem vscode); a tradução acontece aqui, por regra. */
function messageFor(finding: LintFinding): string {
    const arg: string = finding.args?.[0] ?? "";

    switch (finding.ruleId) {
        case "unused-step":
            return vscode.l10n.t('Step "{0}" is declared but never used.', arg);
        case "generic-step-name":
            return vscode.l10n.t('"{0}" is a generic step name. A descriptive name makes the query easier to follow.', arg);
        case "table-buffer":
            return vscode.l10n.t("{0} loads the data into memory and stops query folding from this step on. Make sure that is intended.", arg);
        case "hardcoded-path":
            return vscode.l10n.t("Hardcoded file path. It breaks when someone else refreshes the report; move it to a parameter.");
        case "localhost-source":
            return vscode.l10n.t("Source points to localhost, which usually fails in the Power BI Service or on another machine.");
        case "sensitive-literal":
            return vscode.l10n.t("Possible secret in the query text. Use Power Query credentials or a parameter instead of hardcoding it.");
        case "web-contents-options":
            return vscode.l10n.t("Web.Contents with a hardcoded query string. Use the RelativePath and Query options so credentials, caching and scheduled refresh work reliably.");
        case "remove-columns-risk":
            return vscode.l10n.t("Table.RemoveColumns lets new source columns flow through silently. If you know the final columns, Table.SelectColumns is more explicit.");
        default:
            return finding.message;
    }
}

function toVsRange(range: LintFinding["range"]): vscode.Range {
    return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function shouldLint(doc: vscode.TextDocument): boolean {
    if (!isPowerQueryLikeDocument(doc)) {
        return false;
    }

    // Arquivos .m de outras linguagens (MATLAB, Objective-C) ficam de fora quando o usuário pede.
    const isMFile: boolean = doc.uri.scheme === "file" && path.extname(doc.uri.fsPath).toLowerCase() === ".m";

    return !isMFile || vscode.workspace.getConfiguration("mlens").get<boolean>("files.lintMFiles", true);
}

interface MLensDiagnostic extends vscode.Diagnostic {
    mlensRemovalRange?: vscode.Range;
}

export class LintController implements vscode.Disposable {
    private readonly collection: vscode.DiagnosticCollection;
    private readonly timers: Map<string, NodeJS.Timeout> = new Map();
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.collection = vscode.languages.createDiagnosticCollection("mlens");

        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument((doc: vscode.TextDocument) => this.schedule(doc)),
            vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) =>
                this.schedule(event.document),
            ),
            vscode.workspace.onDidCloseTextDocument((doc: vscode.TextDocument) =>
                this.collection.delete(doc.uri),
            ),
            vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
                if (event.affectsConfiguration("mlens.lint")) {
                    this.lintAllOpen();
                }
            }),
        );

        this.lintAllOpen();
    }

    dispose(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }

        this.collection.dispose();
        this.disposables.forEach((d: vscode.Disposable) => d.dispose());
    }

    lintAllOpen(): void {
        for (const doc of vscode.workspace.textDocuments) {
            this.schedule(doc);
        }
    }

    async lintWorkspace(): Promise<number> {
        const includeM: boolean = vscode.workspace.getConfiguration("mlens").get<boolean>("files.lintMFiles", true);
        const files: vscode.Uri[] = await vscode.workspace.findFiles(
            includeM ? "**/*.{pq,m}" : "**/*.pq",
            "**/{node_modules,.mlens}/**",
        );
        let total: number = 0;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t("M Lens: checking {0} queries…", files.length),
                cancellable: true,
            },
            async (_progress, token: vscode.CancellationToken) => {
                for (const uri of files) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const doc: vscode.TextDocument = await vscode.workspace.openTextDocument(uri);
                    total += await this.lintNow(doc);
                }
            },
        );

        return total;
    }

    private schedule(doc: vscode.TextDocument): void {
        if (!shouldLint(doc)) {
            return;
        }

        const key: string = doc.uri.toString();
        const existing: NodeJS.Timeout | undefined = this.timers.get(key);

        if (existing !== undefined) {
            clearTimeout(existing);
        }

        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                void this.lintNow(doc);
            }, DEBOUNCE_MS),
        );
    }

    private async lintNow(doc: vscode.TextDocument): Promise<number> {
        const enabled: boolean = vscode.workspace.getConfiguration("mlens").get<boolean>("lint.enabled", true);

        if (!enabled) {
            this.collection.delete(doc.uri);

            return 0;
        }

        const findings: ReadonlyArray<LintFinding> = await lintDocument(doc.getText());
        const diagnostics: vscode.Diagnostic[] = [];

        for (const finding of findings) {
            const severity: vscode.DiagnosticSeverity | undefined = severityFor(finding.ruleId);

            if (severity === undefined) {
                continue;
            }

            const diagnostic: MLensDiagnostic = new vscode.Diagnostic(
                toVsRange(finding.range),
                messageFor(finding),
                severity,
            );

            diagnostic.source = SOURCE;
            diagnostic.code = `mlens/${finding.ruleId}`;

            if (finding.removalRange !== undefined) {
                diagnostic.mlensRemovalRange = toVsRange(finding.removalRange);
            }

            diagnostics.push(diagnostic);
        }

        this.collection.set(doc.uri, diagnostics);

        return diagnostics.length;
    }
}

export class LintCodeActionProvider implements vscode.CodeActionProvider {
    static readonly metadata: vscode.CodeActionProviderMetadata = {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    };

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source !== SOURCE) {
                continue;
            }

            const removal: vscode.Range | undefined = (diagnostic as MLensDiagnostic).mlensRemovalRange;

            if (diagnostic.code === "mlens/unused-step" && removal !== undefined) {
                const action: vscode.CodeAction = new vscode.CodeAction(
                    vscode.l10n.t("Remove unused step"),
                    vscode.CodeActionKind.QuickFix,
                );

                action.diagnostics = [diagnostic];
                action.edit = new vscode.WorkspaceEdit();
                action.edit.delete(document.uri, removal);
                actions.push(action);
            }

            if (diagnostic.code === "mlens/generic-step-name") {
                const action: vscode.CodeAction = new vscode.CodeAction(
                    vscode.l10n.t("Rename step"),
                    vscode.CodeActionKind.QuickFix,
                );

                action.diagnostics = [diagnostic];
                action.command = {
                    command: "editor.action.rename",
                    title: vscode.l10n.t("Rename step"),
                };
                actions.push(action);
            }
        }

        return actions;
    }
}
