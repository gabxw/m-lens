/**
 * Comandos VS Code de extração e reaplicação de código M em projetos PBIP.
 *
 * O mapeamento extração -> origem fica em .mlens/pbip-map.json. Na reaplicação o
 * bloco é re-localizado pelo nome (não por número de linha), então edições manuais
 * no .tmdl entre extração e aplicação não corrompem o arquivo.
 */
import * as path from "path";
import * as vscode from "vscode";

import { logInfo } from "../log";
import { applyBlockToText, ExtractedBlock, extractBlocks, normalizeCode } from "./tmdlCore";

export interface QueryMapEntry {
    /** Nome da query (tabela da partition ou expression). */
    readonly name: string;
    /** Caminho relativo ao workspace do arquivo .tmdl de origem. */
    readonly tmdlPath: string;
    readonly kind: ExtractedBlock["kind"];
    /** Arquivo .pq gerado, relativo ao workspace. */
    readonly pqPath: string;
}

const MAP_DIR: string = ".mlens";
const MAP_FILE: string = "pbip-map.json";
const OUTPUT_DIR: string = "mlens-queries";
const PROPOSED_SCHEME: string = "mlens-proposed";

/** Identificadores que só existem no preview do M Lens — quebrariam a query no Power BI. */
const PREVIEW_ONLY: RegExp = /\bMLens_GetCredential\s*\(/;

interface PlannedEntryChange {
    readonly entry: QueryMapEntry;
    readonly changed: boolean;
}

interface PlannedFileChange {
    readonly tmdlPath: string;
    readonly originalText: string;
    readonly updatedText: string;
    readonly entries: PlannedEntryChange[];
}

interface ApplyPlan {
    readonly changes: PlannedFileChange[];
    readonly skipped: string[];
    readonly totalChangedQueries: number;
}

/** Conteúdo "depois de aplicar" de cada .tmdl, servido ao editor de diff. */
const proposed: Map<string, string> = new Map();
const proposedChanged: vscode.EventEmitter<vscode.Uri> = new vscode.EventEmitter<vscode.Uri>();

export function registerProposedProvider(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        proposedChanged,
        vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
            onDidChange: proposedChanged.event,
            provideTextDocumentContent: (uri: vscode.Uri) => proposed.get(uri.path) ?? "",
        }),
    );
}

function safeFileName(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, "_");
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
    const bytes: Uint8Array = await vscode.workspace.fs.readFile(uri);

    return Buffer.from(bytes).toString("utf8");
}

async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
    await ensureParentDirectory(uri);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

async function ensureParentDirectory(uri: vscode.Uri): Promise<void> {
    const parent: vscode.Uri = vscode.Uri.file(path.dirname(uri.fsPath));

    await vscode.workspace.fs.createDirectory(parent);
}

function timestampForPath(): string {
    const now: Date = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");

    return [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        "-",
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
    ].join("");
}

function getFolder(): vscode.WorkspaceFolder | undefined {
    const folder: vscode.WorkspaceFolder | undefined = vscode.workspace.workspaceFolders?.[0];

    if (folder === undefined) {
        void vscode.window.showErrorMessage(vscode.l10n.t("M Lens: open the PBIP project folder first."));
    }

    return folder;
}

/** Mapa de extração, sem mensagens de erro (undefined = ainda não extraído). */
export async function readExtractionMap(folder: vscode.WorkspaceFolder): Promise<QueryMapEntry[] | undefined> {
    const mapUri: vscode.Uri = vscode.Uri.joinPath(folder.uri, MAP_DIR, MAP_FILE);

    try {
        const map: QueryMapEntry[] = JSON.parse(await readTextFile(mapUri)) as QueryMapEntry[];

        // Mapas gerados pela 0.1.0 podiam apontar para os backups em .mlens/.
        return map.filter((entry: QueryMapEntry) => !entry.tmdlPath.startsWith(`${MAP_DIR}/`));
    } catch {
        return undefined;
    }
}

async function loadMap(folder: vscode.WorkspaceFolder): Promise<QueryMapEntry[] | undefined> {
    const map: QueryMapEntry[] | undefined = await readExtractionMap(folder);

    if (map === undefined) {
        const extract: string = vscode.l10n.t("Extract Queries");
        const choice: string | undefined = await vscode.window.showWarningMessage(
            vscode.l10n.t("M Lens: no extracted queries yet. Extract them from the PBIP project first."),
            extract,
        );

        if (choice === extract) {
            await extractPbipQueries();
        }
    }

    return map;
}

export async function extractPbipQueries(): Promise<void> {
    const folder: vscode.WorkspaceFolder | undefined = getFolder();

    if (folder === undefined) {
        return;
    }

    // Backups do próprio M Lens ficam em .mlens/ e não podem entrar na extração.
    const tmdlFiles: vscode.Uri[] = await vscode.workspace.findFiles("**/*.tmdl", "**/{node_modules,.mlens}/**");

    if (tmdlFiles.length === 0) {
        void vscode.window.showWarningMessage(
            vscode.l10n.t("M Lens: no .tmdl files found. In Power BI Desktop, use File > Save as > Power BI Project (.pbip) and open that folder."),
        );

        return;
    }

    const map: QueryMapEntry[] = [];
    const writes: { readonly pqUri: vscode.Uri; readonly content: string; readonly edited: boolean }[] = [];

    for (const tmdlUri of tmdlFiles) {
        const text: string = await readTextFile(tmdlUri);
        const blocks: ExtractedBlock[] = extractBlocks(text);

        for (const block of blocks) {
            if (block.code.trim() === "") {
                continue;
            }

            const pqRelative: string = path.posix.join(OUTPUT_DIR, `${safeFileName(block.name)}.pq`);
            const pqUri: vscode.Uri = vscode.Uri.joinPath(folder.uri, pqRelative);
            let edited: boolean = false;

            try {
                edited = normalizeCode(await readTextFile(pqUri)) !== block.code;
            } catch {
                // .pq ainda não existe.
            }

            writes.push({ pqUri, content: block.code + "\n", edited });

            map.push({
                name: block.name,
                kind: block.kind,
                tmdlPath: path.relative(folder.uri.fsPath, tmdlUri.fsPath).split(path.sep).join("/"),
                pqPath: pqRelative,
            });
        }
    }

    const editedCount: number = writes.filter((write) => write.edited).length;
    let keepEdited: boolean = false;

    if (editedCount > 0) {
        const overwrite: string = vscode.l10n.t("Overwrite");
        const keep: string = vscode.l10n.t("Keep My Edits");

        const choice: string | undefined = await vscode.window.showWarningMessage(
            editedCount === 1
                ? vscode.l10n.t("1 .pq file has edits that were not applied to the PBIP project yet. Extracting again replaces them with the current .tmdl content.")
                : vscode.l10n.t("{0} .pq files have edits that were not applied to the PBIP project yet. Extracting again replaces them with the current .tmdl content.", editedCount),
            { modal: true },
            overwrite,
            keep,
        );

        if (choice === undefined) {
            return;
        }

        keepEdited = choice === keep;
    }

    let count: number = 0;

    for (const write of writes) {
        if (keepEdited && write.edited) {
            continue;
        }

        await writeTextFile(write.pqUri, write.content);
        count += 1;
    }

    const mapUri: vscode.Uri = vscode.Uri.joinPath(folder.uri, MAP_DIR, MAP_FILE);
    await writeTextFile(mapUri, JSON.stringify(map, null, 2) + "\n");

    logInfo(`PBIP: extracted ${count} queries to ${OUTPUT_DIR}/.`);
    void vscode.commands.executeCommand("mlens.refresh");

    const open: string = vscode.l10n.t("Show Files");
    const choice: string | undefined = await vscode.window.showInformationMessage(
        vscode.l10n.t('M Lens: {0} queries extracted to "{1}". Edit them, then run Apply Queries to PBIP.', count, `${OUTPUT_DIR}/`),
        open,
    );

    if (choice === open && writes.length > 0) {
        await vscode.commands.executeCommand("revealInExplorer", writes[0].pqUri);
    }
}

/** Antes de planejar, salva .pq editados e ainda não salvos — aplicar lê do disco. */
async function saveDirtyQueries(folder: vscode.WorkspaceFolder): Promise<void> {
    const outputRoot: string = vscode.Uri.joinPath(folder.uri, OUTPUT_DIR).fsPath.toLowerCase();

    for (const doc of vscode.workspace.textDocuments) {
        if (doc.isDirty && doc.uri.scheme === "file" && doc.uri.fsPath.toLowerCase().startsWith(outputRoot)) {
            await doc.save();
        }
    }
}

async function buildApplyPlan(folder: vscode.WorkspaceFolder, map: readonly QueryMapEntry[]): Promise<ApplyPlan> {
    const changes: PlannedFileChange[] = [];
    const skipped: string[] = [];

    const byTmdl: Map<string, QueryMapEntry[]> = new Map();

    for (const entry of map) {
        const list: QueryMapEntry[] = byTmdl.get(entry.tmdlPath) ?? [];
        list.push(entry);
        byTmdl.set(entry.tmdlPath, list);
    }

    for (const [tmdlPath, entries] of byTmdl) {
        const tmdlUri: vscode.Uri = vscode.Uri.joinPath(folder.uri, ...tmdlPath.split("/"));

        let originalText: string;

        try {
            originalText = await readTextFile(tmdlUri);
        } catch {
            skipped.push(vscode.l10n.t("{0}: .tmdl file not found", tmdlPath));
            continue;
        }

        let text: string = originalText;
        const entryChanges: PlannedEntryChange[] = [];

        for (const entry of entries) {
            const pqUri: vscode.Uri = vscode.Uri.joinPath(folder.uri, ...entry.pqPath.split("/"));

            let code: string;

            try {
                code = await readTextFile(pqUri);
            } catch {
                skipped.push(vscode.l10n.t("{0}: {1} not found", entry.name, entry.pqPath));
                continue;
            }

            const updated: string | undefined = applyBlockToText(text, entry.name, entry.kind, code);

            if (updated === undefined) {
                skipped.push(vscode.l10n.t("{0}: query no longer exists in {1}", entry.name, tmdlPath));
                continue;
            }

            if (updated !== text && PREVIEW_ONLY.test(code)) {
                skipped.push(vscode.l10n.t("{0}: uses MLens_GetCredential, which only works in M Lens previews", entry.name));
                continue;
            }

            entryChanges.push({
                entry,
                changed: updated !== text,
            });

            text = updated;
        }

        if (text !== originalText) {
            changes.push({
                tmdlPath,
                originalText,
                updatedText: text,
                entries: entryChanges.filter((entry: PlannedEntryChange) => entry.changed),
            });
        }
    }

    return {
        changes,
        skipped,
        totalChangedQueries: changes.reduce(
            (total: number, change: PlannedFileChange) => total + change.entries.length,
            0,
        ),
    };
}

/** Quantas queries editadas ainda não foram aplicadas (para a barra lateral). */
export async function countPendingPbipChanges(
    folder: vscode.WorkspaceFolder,
    map: readonly QueryMapEntry[],
): Promise<number> {
    return (await buildApplyPlan(folder, map)).totalChangedQueries;
}

/** Abre o diff de cada .tmdl alterado: arquivo atual × como fica depois de aplicar. */
async function reviewPlan(folder: vscode.WorkspaceFolder, plan: ApplyPlan): Promise<void> {
    if (plan.changes.length === 0) {
        void vscode.window.showInformationMessage(
            plan.skipped.length > 0
                ? vscode.l10n.t("M Lens: nothing to apply. Skipped: {0}", plan.skipped.join("; "))
                : vscode.l10n.t("M Lens: no edited queries to apply."),
        );

        return;
    }

    type ChangeItem = vscode.QuickPickItem & { readonly change: PlannedFileChange };

    const items: ChangeItem[] = plan.changes.map((change: PlannedFileChange) => ({
        label: `$(diff) ${change.tmdlPath}`,
        description: change.entries.map((item: PlannedEntryChange) => item.entry.name).join(", "),
        change,
    }));

    const picked: ChangeItem | undefined =
        items.length === 1
            ? items[0]
            : await vscode.window.showQuickPick(items, {
                  title: vscode.l10n.t("M Lens: review PBIP changes"),
                  placeHolder: vscode.l10n.t("Select a file to compare"),
              });

    if (picked === undefined) {
        return;
    }

    const tmdlUri: vscode.Uri = vscode.Uri.joinPath(folder.uri, ...picked.change.tmdlPath.split("/"));
    const proposedUri: vscode.Uri = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${picked.change.tmdlPath}` });

    proposed.set(proposedUri.path, picked.change.updatedText);
    proposedChanged.fire(proposedUri);

    await vscode.commands.executeCommand(
        "vscode.diff",
        tmdlUri,
        proposedUri,
        vscode.l10n.t("{0} (current ↔ after apply)", path.posix.basename(picked.change.tmdlPath)),
    );

    if (plan.skipped.length > 0) {
        void vscode.window.showWarningMessage(vscode.l10n.t("M Lens: skipped {0}", plan.skipped.join("; ")));
    }
}

async function writeBackups(folder: vscode.WorkspaceFolder, plan: ApplyPlan): Promise<string | undefined> {
    if (plan.changes.length === 0) {
        return undefined;
    }

    const stamp: string = timestampForPath();
    const backupRoot: vscode.Uri = vscode.Uri.joinPath(folder.uri, MAP_DIR, "backups", stamp);

    for (const change of plan.changes) {
        const backupUri: vscode.Uri = vscode.Uri.joinPath(backupRoot, ...change.tmdlPath.split("/"));
        await writeTextFile(backupUri, change.originalText);
    }

    return path.posix.join(MAP_DIR, "backups", stamp);
}

export async function previewPbipApply(): Promise<void> {
    const folder: vscode.WorkspaceFolder | undefined = getFolder();

    if (folder === undefined) {
        return;
    }

    const map: QueryMapEntry[] | undefined = await loadMap(folder);

    if (map === undefined) {
        return;
    }

    await saveDirtyQueries(folder);
    await reviewPlan(folder, await buildApplyPlan(folder, map));
}

export async function applyPbipQueries(skipConfirmation: boolean = false): Promise<void> {
    const folder: vscode.WorkspaceFolder | undefined = getFolder();

    if (folder === undefined) {
        return;
    }

    const map: QueryMapEntry[] | undefined = await loadMap(folder);

    if (map === undefined) {
        return;
    }

    await saveDirtyQueries(folder);

    const plan: ApplyPlan = await buildApplyPlan(folder, map);

    if (plan.changes.length === 0) {
        const message: string =
            plan.skipped.length > 0
                ? vscode.l10n.t("M Lens: nothing to apply. Skipped: {0}", plan.skipped.join("; "))
                : vscode.l10n.t("M Lens: no edited queries to apply.");

        void vscode.window.showWarningMessage(message);

        return;
    }

    if (!skipConfirmation) {
        const apply: string = vscode.l10n.t("Apply with Backup");
        const review: string = vscode.l10n.t("Review Changes");
        const choice: string | undefined = await vscode.window.showWarningMessage(
            vscode.l10n.t("Apply the edited queries to the PBIP project?"),
            {
                modal: true,
                detail: [
                    vscode.l10n.t("Edited queries: {0} · .tmdl files: {1}", plan.totalChangedQueries, plan.changes.length),
                    vscode.l10n.t("A copy of every changed .tmdl is saved in .mlens/backups first. Close the project in Power BI Desktop before applying."),
                ].join("\n\n"),
            },
            apply,
            review,
        );

        if (choice === review) {
            await reviewPlan(folder, plan);

            return;
        }

        if (choice !== apply) {
            return;
        }
    }

    const backupPath: string | undefined = await writeBackups(folder, plan);

    for (const change of plan.changes) {
        const tmdlUri: vscode.Uri = vscode.Uri.joinPath(folder.uri, ...change.tmdlPath.split("/"));

        await writeTextFile(tmdlUri, change.updatedText);
    }

    logInfo(`PBIP: applied ${plan.totalChangedQueries} queries. Backup: ${backupPath ?? "-"}.`);
    void vscode.commands.executeCommand("mlens.refresh");

    const summary: string =
        plan.totalChangedQueries === 1
            ? vscode.l10n.t("M Lens: 1 query applied. Backup in {0}.", backupPath ?? "-")
            : vscode.l10n.t("M Lens: {0} queries applied. Backup in {1}.", plan.totalChangedQueries, backupPath ?? "-");

    if (plan.skipped.length > 0) {
        void vscode.window.showWarningMessage(`${summary} ${vscode.l10n.t("Skipped: {0}", plan.skipped.join("; "))}`);
    } else {
        void vscode.window.showInformationMessage(summary);
    }
}
