/**
 * Relatórios e guias do M Lens como documentos virtuais somente leitura (esquema
 * `mlens-report:`), abertos no preview de Markdown. Diferente de um documento sem
 * título, não ficam "sujos" nem perguntam se devem ser salvos ao fechar.
 */
import * as vscode from "vscode";

const SCHEME: string = "mlens-report";
const contents: Map<string, string> = new Map();
const changed: vscode.EventEmitter<vscode.Uri> = new vscode.EventEmitter<vscode.Uri>();

export function registerReportProvider(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        changed,
        vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
            onDidChange: changed.event,
            provideTextDocumentContent: (uri: vscode.Uri) => contents.get(uri.path) ?? "",
        }),
    );
}

export async function showReadOnlyMarkdown(id: string, content: string): Promise<void> {
    const uri: vscode.Uri = vscode.Uri.from({ scheme: SCHEME, path: `/${id}.md` });

    contents.set(uri.path, content);
    changed.fire(uri);

    try {
        await vscode.commands.executeCommand("markdown.showPreview", uri);
    } catch {
        // Extensão de Markdown desativada: mostra o texto mesmo.
        const doc: vscode.TextDocument = await vscode.workspace.openTextDocument(uri);
        await vscode.languages.setTextDocumentLanguage(doc, "markdown");
        await vscode.window.showTextDocument(doc, { preview: true });
    }
}
