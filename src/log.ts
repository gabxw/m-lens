import * as vscode from "vscode";

let output: vscode.OutputChannel | undefined;

export function getLogChannel(): vscode.OutputChannel {
    if (output === undefined) {
        output = vscode.window.createOutputChannel("M Lens");
    }

    return output;
}

export function logInfo(message: string): void {
    getLogChannel().appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

export function showLog(): void {
    getLogChannel().show(true);
}
