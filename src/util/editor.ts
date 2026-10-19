/**
 * Qual query o usuário está editando. Quando um painel do M Lens (webview ou view
 * da barra lateral) tem o foco, `activeTextEditor` fica undefined; por isso guardamos
 * o último editor Power Query visto e os comandos usam ele como alvo.
 */
import * as path from "path";
import * as vscode from "vscode";

let lastQueryUri: vscode.Uri | undefined;

export function isPowerQueryLikeDocument(doc: vscode.TextDocument): boolean {
    if (doc.languageId === "powerquery") {
        return true;
    }

    if (doc.uri.scheme !== "file") {
        return false;
    }

    const ext: string = path.extname(doc.uri.fsPath).toLowerCase();

    return ext === ".pq" || ext === ".m";
}

export function trackPowerQueryEditors(context: vscode.ExtensionContext): void {
    const remember = (editor: vscode.TextEditor | undefined): void => {
        if (editor !== undefined && isPowerQueryLikeDocument(editor.document)) {
            lastQueryUri = editor.document.uri;
        }
    };

    remember(vscode.window.activeTextEditor);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(remember),
        vscode.workspace.onDidCloseTextDocument((doc: vscode.TextDocument) => {
            if (lastQueryUri !== undefined && doc.uri.toString() === lastQueryUri.toString()) {
                lastQueryUri = undefined;
            }
        }),
    );
}

/** Documento Power Query alvo: o editor ativo, senão o último editado. */
export async function getTargetQueryDocument(): Promise<vscode.TextDocument | undefined> {
    const active: vscode.TextEditor | undefined = vscode.window.activeTextEditor;

    if (active !== undefined && isPowerQueryLikeDocument(active.document)) {
        return active.document;
    }

    if (lastQueryUri === undefined) {
        return undefined;
    }

    return vscode.workspace.textDocuments.find((doc: vscode.TextDocument) => doc.uri.toString() === lastQueryUri?.toString());
}

/** Editor para inserir texto: mostra de novo o documento alvo, se preciso. */
export async function getTargetQueryEditor(): Promise<vscode.TextEditor | undefined> {
    const doc: vscode.TextDocument | undefined = await getTargetQueryDocument();

    if (doc === undefined) {
        return undefined;
    }

    const visible: vscode.TextEditor | undefined = vscode.window.visibleTextEditors.find(
        (editor: vscode.TextEditor) => editor.document === doc,
    );

    return visible ?? vscode.window.showTextDocument(doc, { preserveFocus: false });
}
