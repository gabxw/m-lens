/**
 * Preview de dados via PQTest.exe (Microsoft.PowerQuery.SdkTools).
 *
 * O PQTest é distribuído pela extensão oficial "Power Query SDK" (nuget
 * Microsoft.PowerQuery.SdkTools) e só existe para Windows. O M Lens tenta
 * localizar o executável automaticamente; o caminho também pode ser fixado em
 * mlens.preview.pqTestPath. Recurso marcado como experimental.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { logInfo } from "../log";
import { getTargetQueryDocument } from "../util/editor";
import { isSectionDocument } from "./credentialM";
import {
    buildPreviewQueryWithCredentials,
    getCredentialCachePath,
    registerSavedSqlLogins,
    resolveMissingCredential,
} from "./credentials";
import { showResultPanel } from "./resultPanel";

const EVAL_TIMEOUT_MS: number = 120_000;
const MAX_CREDENTIAL_RETRIES: number = 6;
const SDK_EXTENSION_ID: string = "powerquery.vscode-powerquery-sdk";

interface RunTestParsed {
    readonly status?: string;
    readonly errorMessage?: string;
    readonly credentialMissing?: { readonly kind: string; readonly path: string };
}

interface EvaluationResult {
    readonly output: string;
    readonly parsed: RunTestParsed;
    /** Credenciais registradas no cache durante esta avaliação. */
    readonly registeredCredentials: number;
}

class EvaluationCancelled extends Error {}

function parseRunTest(output: string): RunTestParsed {
    let parsed: unknown;

    try {
        parsed = JSON.parse(output);
    } catch {
        return {};
    }

    const first: unknown = Array.isArray(parsed) ? parsed[0] : parsed;

    if (first === null || typeof first !== "object") {
        return {};
    }

    const record = first as Record<string, unknown>;
    const status: string | undefined = typeof record.Status === "string" ? record.Status : undefined;
    const error = record.Error as Record<string, unknown> | undefined;

    if (error === undefined || error === null) {
        return { status };
    }

    const errorMessage: string | undefined = typeof error.Message === "string" ? error.Message : undefined;
    const details = (error.Details ?? {}) as Record<string, unknown>;

    if (details["Microsoft.Data.Mashup.CredentialError.Reason"] === "CredentialMissing") {
        const kind = details["Microsoft.Data.Mashup.CredentialError.DataSourceKind"];
        const dsPath = details["Microsoft.Data.Mashup.CredentialError.DataSourcePath"];

        if (typeof kind === "string" && typeof dsPath === "string") {
            return { status, errorMessage, credentialMissing: { kind, path: dsPath } };
        }
    }

    return { status, errorMessage };
}

export async function evaluateCurrentQuery(context: vscode.ExtensionContext): Promise<void> {
    const document: vscode.TextDocument | undefined = await getTargetQueryDocument();

    if (document === undefined) {
        void vscode.window.showWarningMessage(vscode.l10n.t("M Lens: open a .pq file to preview its data."));

        return;
    }

    const sourceQueryText: string = document.getText();

    if (isSectionDocument(sourceQueryText)) {
        void vscode.window.showWarningMessage(
            vscode.l10n.t("M Lens: this file has a whole section (all queries of a PBIX). Copy one query into its own .pq file to preview it."),
        );

        return;
    }

    const pqTest: string | undefined = await findPqTest();

    if (pqTest === undefined) {
        const install: string = vscode.l10n.t("Install Power Query SDK");
        const choice: string | undefined = await vscode.window.showErrorMessage(
            vscode.l10n.t("M Lens: data preview needs PQTest.exe, which comes with the Power Query SDK extension (Windows only). You can also set mlens.preview.pqTestPath."),
            install,
        );

        if (choice === install) {
            await vscode.commands.executeCommand("workbench.extensions.search", SDK_EXTENSION_ID);
        }

        return;
    }

    const preparedQuery = await buildPreviewQueryWithCredentials(context, sourceQueryText);

    // O conteúdo atual (mesmo sem salvar) vai para um arquivo temporário .query.pq.
    // Credenciais de API referenciadas entram só neste arquivo, que é apagado no fim.
    const tmpFile: string = path.join(os.tmpdir(), `mlens-eval-${Date.now()}.query.pq`);
    fs.writeFileSync(tmpFile, preparedQuery.text, "utf8");

    const title: string = path.basename(document.fileName);

    logInfo(`Preview: evaluating ${title} with ${pqTest}.`);

    try {
        const result: EvaluationResult = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t("M Lens: running {0}…", title),
                cancellable: true,
            },
            (_progress, token: vscode.CancellationToken) =>
                runWithCredentials(context, pqTest, tmpFile, sourceQueryText, token),
        );

        const credentialCount: number = preparedQuery.credentialCount + result.registeredCredentials;
        const failed: boolean = result.parsed.status === "Failed" || result.parsed.errorMessage !== undefined;

        if (!failed) {
            logInfo(`Preview: ${title} evaluated.`);
            showResultPanel(context, title, result.output, { kind: "data", credentialCount });

            return;
        }

        const message: string = result.parsed.errorMessage ?? vscode.l10n.t("The evaluation failed.");

        logInfo(`Preview: ${title} failed: ${message}`);
        showResultPanel(context, title, "", {
            kind: "error",
            error: message,
            credentialCount,
            probablyCredentialError: result.parsed.credentialMissing !== undefined || isProbablyCredentialError(message),
        });
    } catch (error) {
        if (error instanceof EvaluationCancelled) {
            logInfo(`Preview: ${title} cancelled.`);

            return;
        }

        const message: string = error instanceof Error ? error.message : String(error);

        logInfo(`Preview: ${title} failed: ${message}`);
        showResultPanel(context, title, "", {
            kind: "error",
            error: message,
            credentialCount: preparedQuery.credentialCount,
            probablyCredentialError: isProbablyCredentialError(message),
        });
    } finally {
        try {
            fs.unlinkSync(tmpFile);
        } catch {
            // arquivo temporário; ignorar
        }
    }
}

/**
 * Roda o PQTest. Antes, registra os logins SQL salvos para as fontes da query; quando o
 * PQTest ainda reclama de credencial ausente, resolve na hora (File/Folder sozinho, SQL e
 * Web perguntando ao usuário) e tenta de novo.
 */
async function runWithCredentials(
    context: vscode.ExtensionContext,
    pqTest: string,
    tmpFile: string,
    sourceQueryText: string,
    token: vscode.CancellationToken,
): Promise<EvaluationResult> {
    const cachePath: string = await getCredentialCachePath(context);
    let registeredCredentials: number = await registerSavedSqlLogins(context, pqTest, cachePath, sourceQueryText);

    const handled: Set<string> = new Set();
    let output: string = "";
    let parsed: RunTestParsed = {};

    for (let attempt: number = 0; attempt < MAX_CREDENTIAL_RETRIES; attempt += 1) {
        const cfp: string | undefined = fs.existsSync(cachePath) ? cachePath : undefined;
        output = await runPqTest(pqTest, tmpFile, cfp, token);
        parsed = parseRunTest(output);

        const missing: RunTestParsed["credentialMissing"] = parsed.credentialMissing;

        if (missing === undefined) {
            break;
        }

        const key: string = `${missing.kind}|${missing.path.toLowerCase()}`;

        if (handled.has(key)) {
            // Já tentamos resolver esta fonte e ainda falta credencial — não insistir.
            break;
        }

        handled.add(key);

        if (!(await resolveMissingCredential(context, pqTest, cachePath, missing.kind, missing.path))) {
            break;
        }

        registeredCredentials += 1;
    }

    return { output, parsed, registeredCredentials };
}

function isProbablyCredentialError(message: string): boolean {
    return /(credential|credencial|authentication|autentica|unauthorized|forbidden|access denied|permission|privacy|OAuth|login failed)/i.test(
        message,
    );
}

function runPqTest(
    pqTestPath: string,
    queryFile: string,
    credentialCachePath: string | undefined,
    token: vscode.CancellationToken,
): Promise<string> {
    const args: string[] = ["run-test", "--prettyPrint", "--queryFile", queryFile];

    if (credentialCachePath !== undefined) {
        args.push("--CredentialsFilePath", credentialCachePath);
    }

    const abort: AbortController = new AbortController();
    const subscription: vscode.Disposable = token.onCancellationRequested(() => abort.abort());

    return new Promise<string>((resolve, reject) => {
        execFile(
            pqTestPath,
            args,
            { timeout: EVAL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true, signal: abort.signal },
            (error, stdout, stderr) => {
                subscription.dispose();

                if (token.isCancellationRequested) {
                    reject(new EvaluationCancelled());

                    return;
                }

                if (stderr.trim() !== "") {
                    logInfo(`PQTest stderr: ${stderr.trim()}`);
                }

                if (error !== null && stdout.trim() === "") {
                    reject(new Error(stderr.trim() !== "" ? stderr : error.message));

                    return;
                }

                resolve(stdout);
            },
        );
    });
}

let pqTestCache: { readonly configured: string; readonly found: string | undefined } | undefined;
let globalStorageRoot: string | undefined;

/** Pasta globalStorage do editor em uso (Code, Insiders, Cursor...), onde o SDK baixa o PQTest. */
export function initPqTestLocator(context: vscode.ExtensionContext): void {
    globalStorageRoot = path.dirname(context.globalStorageUri.fsPath);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
            if (event.affectsConfiguration("mlens.preview.pqTestPath")) {
                pqTestCache = undefined;
            }
        }),
        vscode.extensions.onDidChange(() => {
            pqTestCache = undefined;
        }),
    );
}

export async function findPqTest(): Promise<string | undefined> {
    const configured: string = vscode.workspace.getConfiguration("mlens").get<string>("preview.pqTestPath", "").trim();

    if (pqTestCache !== undefined && pqTestCache.configured === configured && (pqTestCache.found === undefined || fs.existsSync(pqTestCache.found))) {
        return pqTestCache.found;
    }

    const found: string | undefined = await locatePqTest(configured);

    pqTestCache = { configured, found };

    return found;
}

async function locatePqTest(configured: string): Promise<string | undefined> {
    if (configured !== "") {
        return fs.existsSync(configured) ? configured : undefined;
    }

    if (process.platform !== "win32") {
        return undefined;
    }

    const roots: string[] = [];

    if (globalStorageRoot !== undefined) {
        roots.push(path.join(globalStorageRoot, SDK_EXTENSION_ID));
    }

    roots.push(path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", SDK_EXTENSION_ID));

    const sdkPath: string | undefined = vscode.extensions.getExtension(SDK_EXTENSION_ID)?.extensionPath;

    if (sdkPath !== undefined) {
        roots.push(sdkPath);
    }

    for (const root of [...new Set(roots)]) {
        const found: string | undefined = await findFileRecursive(root, "pqtest.exe", 6);

        if (found !== undefined) {
            return found;
        }
    }

    return undefined;
}

async function findFileRecursive(root: string, fileName: string, maxDepth: number): Promise<string | undefined> {
    if (maxDepth < 0) {
        return undefined;
    }

    let entries: fs.Dirent[];

    try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
        return undefined;
    }

    for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase() === fileName) {
            return path.join(root, entry.name);
        }
    }

    for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "node_modules") {
            const found: string | undefined = await findFileRecursive(path.join(root, entry.name), fileName, maxDepth - 1);

            if (found !== undefined) {
                return found;
            }
        }
    }

    return undefined;
}
