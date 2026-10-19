import * as vscode from "vscode";

import { showWorkspaceReport } from "./analysis/workspace";
import { LintCodeActionProvider, LintController } from "./lint/diagnostics";
import { logInfo, showLog } from "./log";
import { applyPbipQueries, extractPbipQueries, previewPbipApply, registerProposedProvider } from "./pbip/tmdl";
import { extractPbixQueries } from "./pbix/pbix";
import { managePreviewCredentials, migrateLegacySqlCredential } from "./preview/credentials";
import { evaluateCurrentQuery, initPqTestLocator } from "./preview/evaluator";
import { registerSidebar } from "./sidebar/projectView";
import { trackPowerQueryEditors } from "./util/editor";
import { registerReportProvider } from "./util/markdown";

export function activate(context: vscode.ExtensionContext): void {
    const lintController: LintController = new LintController();
    const powerQuerySelector: vscode.DocumentSelector = [
        { language: "powerquery" },
        { scheme: "file", pattern: "**/*.pq" },
        { scheme: "file", pattern: "**/*.m" },
    ];

    logInfo("Extension activated.");

    trackPowerQueryEditors(context);
    initPqTestLocator(context);
    registerReportProvider(context);
    registerProposedProvider(context);
    void migrateLegacySqlCredential(context);

    const refreshSidebar: () => void = registerSidebar(context);

    context.subscriptions.push(
        lintController,

        vscode.languages.registerCodeActionsProvider(
            powerQuerySelector,
            new LintCodeActionProvider(),
            LintCodeActionProvider.metadata,
        ),

        vscode.commands.registerCommand("mlens.lintWorkspace", async () => {
            const total: number = await lintController.lintWorkspace();
            const show: string = vscode.l10n.t("Show Problems");
            const message: string =
                total === 0
                    ? vscode.l10n.t("M Lens: check finished, no findings.")
                    : total === 1
                      ? vscode.l10n.t("M Lens: check finished, 1 finding.")
                      : vscode.l10n.t("M Lens: check finished, {0} findings.", total);
            const choice: string | undefined = await vscode.window.showInformationMessage(
                message,
                ...(total > 0 ? [show] : []),
            );

            if (choice === show) {
                await vscode.commands.executeCommand("workbench.actions.view.problems");
            }
        }),

        vscode.commands.registerCommand("mlens.refresh", () => refreshSidebar()),
        vscode.commands.registerCommand("mlens.extractPbipQueries", () => extractPbipQueries()),
        vscode.commands.registerCommand("mlens.previewPbipApply", () => previewPbipApply()),
        vscode.commands.registerCommand("mlens.applyPbipQueries", () => applyPbipQueries()),
        vscode.commands.registerCommand("mlens.extractPbixQueries", (uri?: vscode.Uri) => extractPbixQueries(uri)),
        vscode.commands.registerCommand("mlens.evaluateQuery", () => evaluateCurrentQuery(context)),
        vscode.commands.registerCommand("mlens.managePreviewCredentials", () => managePreviewCredentials(context)),
        vscode.commands.registerCommand("mlens.showWorkspaceReport", () => showWorkspaceReport()),
        vscode.commands.registerCommand("mlens.showLog", () => showLog()),

        // Comandos da 0.1.x: continuam funcionando (atalhos de teclado, tarefas), fora da paleta.
        vscode.commands.registerCommand("mlens.openDashboard", () =>
            vscode.commands.executeCommand("workbench.view.extension.mlens"),
        ),
        vscode.commands.registerCommand("mlens.scanDataSources", () => showWorkspaceReport()),
        vscode.commands.registerCommand("mlens.showDependencyMap", () => showWorkspaceReport()),
        vscode.commands.registerCommand("mlens.diagnoseWorkspace", () => showWorkspaceReport()),
        vscode.commands.registerCommand("mlens.configureSqlPreviewCredentials", () => managePreviewCredentials(context)),
    );
}

export function deactivate(): void {
    // nada a limpar além dos subscriptions
}
