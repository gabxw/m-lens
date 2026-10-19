/** Cola com o VS Code do painel de resultado — renderização pura em resultPanelCore.ts. */
import { randomBytes } from "crypto";
import * as vscode from "vscode";

import { renderHtml, ResultPanelOptions, ResultPanelStrings } from "./resultPanelCore";

export { ResultPanelOptions } from "./resultPanelCore";

let panel: vscode.WebviewPanel | undefined;
let didBindMessages: boolean = false;

function panelStrings(): ResultPanelStrings {
    return {
        subtitle: vscode.l10n.t("Data preview with PQTest"),
        credentials: vscode.l10n.t("Credentials"),
        filterLabel: vscode.l10n.t("Filter rows"),
        filterPlaceholder: vscode.l10n.t("Filter rows…"),
        rowsSummary: vscode.l10n.t("{0} of {1} rows"),
        truncated: vscode.l10n.t("Showing the first {0} of {1} rows (mlens.preview.maxRows)"),
        columns: vscode.l10n.t("{0} columns"),
        credentialsUsed: vscode.l10n.t("Credentials used: {0}"),
        textResult: vscode.l10n.t("Text result"),
        jsonResult: vscode.l10n.t("JSON result"),
        detailColumn: vscode.l10n.t("Column"),
        row: vscode.l10n.t("Row {0}"),
        empty: vscode.l10n.t("(empty)"),
        detailHint: vscode.l10n.t("Select a row to read its full values here."),
        resize: vscode.l10n.t("Drag to resize"),
        sortHint: vscode.l10n.t("Select a column header to sort"),
        errorTitle: vscode.l10n.t("The query failed"),
        credentialHintTitle: vscode.l10n.t("This looks like a credential problem."),
        credentialHint: vscode.l10n.t(
            "Run the preview again to choose a login, or open Manage credentials to change a saved one. Sources with organizational sign-in (SharePoint Online, OAuth) still need a credential set up with the Power Query SDK.",
        ),
        genericHint: vscode.l10n.t("Show log has the full PQTest output."),
        manageCredentials: vscode.l10n.t("Manage credentials"),
        showLog: vscode.l10n.t("Show log"),
        unknownError: vscode.l10n.t("Unknown error."),
    };
}

export function showResultPanel(
    context: vscode.ExtensionContext,
    title: string,
    rawOutput: string,
    options: ResultPanelOptions = {},
): void {
    if (panel === undefined) {
        panel = vscode.window.createWebviewPanel("mlensResult", "M Lens", vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [],
        });

        panel.onDidDispose(() => {
            panel = undefined;
            didBindMessages = false;
        }, undefined, context.subscriptions);
    }

    if (!didBindMessages) {
        panel.webview.onDidReceiveMessage(
            async (message: { command?: string }) => {
                switch (message.command) {
                    case "manageCredentials":
                        await vscode.commands.executeCommand("mlens.managePreviewCredentials");
                        break;
                    case "showLog":
                        await vscode.commands.executeCommand("mlens.showLog");
                        break;
                    default:
                        break;
                }
            },
            undefined,
            context.subscriptions,
        );
        didBindMessages = true;
    }

    const maxRows: number = vscode.workspace.getConfiguration("mlens").get<number>("preview.maxRows", 500);

    panel.title = vscode.l10n.t("Preview: {0}", title);
    panel.webview.html = renderHtml(title, rawOutput, options, maxRows, {
        strings: panelStrings(),
        cspSource: panel.webview.cspSource,
        nonce: randomBytes(16).toString("base64"),
    });
    panel.reveal(vscode.ViewColumn.Beside, true);
}
