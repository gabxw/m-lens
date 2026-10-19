/**
 * Barra lateral do M Lens (views nativas, seguem qualquer tema).
 *
 * As três views compartilham um único WorkspaceReport, recalculado sob demanda depois
 * que algo relevante muda (.pq/.m/.tmdl/.pbip, mapa de extração, configuração).
 */
import * as path from "path";
import * as vscode from "vscode";

import {
    analyzeWorkspace,
    DataSourceFinding,
    getWorkspaceFolder,
    QueryDependency,
    WorkspaceReport,
} from "../analysis/workspace";

const REFRESH_DEBOUNCE_MS: number = 800;

class ReportCache {
    private pending: Promise<WorkspaceReport | undefined> | undefined;
    private readonly changed: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidChange: vscode.Event<void> = this.changed.event;

    get(): Promise<WorkspaceReport | undefined> {
        if (this.pending === undefined) {
            this.pending = analyzeWorkspace().then((report: WorkspaceReport | undefined) => {
                void vscode.commands.executeCommand("setContext", "mlens.hasExtraction", (report?.extractedCount ?? 0) > 0);
                void vscode.commands.executeCommand("setContext", "mlens.hasTmdl", (report?.tmdlCount ?? 0) > 0);

                return report;
            });
        }

        return this.pending;
    }

    invalidate(): void {
        this.pending = undefined;
        this.changed.fire();
    }

    dispose(): void {
        this.changed.dispose();
    }
}

type Node = vscode.TreeItem & { readonly children?: Node[] };

function item(
    label: string,
    options: {
        description?: string;
        tooltip?: string;
        icon?: string;
        color?: string;
        command?: vscode.Command;
        children?: Node[];
        resourceUri?: vscode.Uri;
    } = {},
): Node {
    const node: vscode.TreeItem & { children?: Node[] } = new vscode.TreeItem(
        label,
        options.children !== undefined && options.children.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None,
    );

    node.description = options.description;
    node.tooltip = options.tooltip ?? (options.description !== undefined ? `${label} · ${options.description}` : label);
    node.command = options.command;
    node.children = options.children;
    node.resourceUri = options.resourceUri;

    if (options.icon !== undefined) {
        node.iconPath = new vscode.ThemeIcon(options.icon, options.color !== undefined ? new vscode.ThemeColor(options.color) : undefined);
    }

    return node;
}

function openAt(uri: vscode.Uri, line?: number): vscode.Command {
    const position: vscode.Position = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);

    return {
        command: "vscode.open",
        title: vscode.l10n.t("Open"),
        arguments: [uri, { selection: new vscode.Range(position, position), preview: true }],
    };
}

function command(id: string, title: string, args: unknown[] = []): vscode.Command {
    return { command: id, title, arguments: args };
}

class OverviewProvider implements vscode.TreeDataProvider<Node> {
    private readonly changed: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData: vscode.Event<void> = this.changed.event;

    constructor(private readonly cache: ReportCache) {
        cache.onDidChange(() => this.changed.fire());
    }

    getTreeItem(element: Node): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: Node): Promise<Node[]> {
        if (element !== undefined) {
            return element.children ?? [];
        }

        const report: WorkspaceReport | undefined = await this.cache.get();

        // Lista vazia mostra o conteúdo de boas-vindas (viewsWelcome no package.json).
        if (report === undefined || (report.queryFiles.length === 0 && report.tmdlCount === 0 && report.pbipFiles.length === 0)) {
            return [];
        }

        const nodes: Node[] = [];
        const folder: vscode.WorkspaceFolder | undefined = getWorkspaceFolder();
        const projectName: string =
            report.pbipFiles.length > 0 ? path.posix.basename(report.pbipFiles[0], ".pbip") : report.workspaceName;

        nodes.push(
            item(projectName, {
                description: report.pbipFiles.length > 0 ? vscode.l10n.t("Power BI Project") : vscode.l10n.t("Power Query files"),
                icon: report.pbipFiles.length > 0 ? "project" : "folder",
            }),
        );

        if (report.tmdlCount > 0 && report.extractedCount === 0) {
            nodes.push(
                item(vscode.l10n.t("Extract queries to edit them"), {
                    description: vscode.l10n.t("{0} .tmdl files", report.tmdlCount),
                    tooltip: vscode.l10n.t("Copies every Power Query from the PBIP project into .pq files you can edit, lint and preview."),
                    icon: "arrow-circle-down",
                    color: "charts.blue",
                    command: command("mlens.extractPbipQueries", vscode.l10n.t("Extract Queries from PBIP")),
                }),
            );
        } else if (report.extractedCount > 0) {
            nodes.push(
                item(vscode.l10n.t("Extracted queries"), {
                    description: vscode.l10n.t("{0} in mlens-queries", report.extractedCount),
                    icon: "symbol-function",
                    command:
                        folder !== undefined
                            ? command("revealInExplorer", vscode.l10n.t("Show Files"), [vscode.Uri.joinPath(folder.uri, "mlens-queries")])
                            : undefined,
                }),
            );

            nodes.push(
                report.pendingChanges > 0
                    ? item(vscode.l10n.t("Changes to apply"), {
                          description:
                              report.pendingChanges === 1
                                  ? vscode.l10n.t("1 edited query")
                                  : vscode.l10n.t("{0} edited queries", report.pendingChanges),
                          tooltip: vscode.l10n.t("Review the edited queries and write them back to the PBIP project."),
                          icon: "diff-modified",
                          color: "charts.orange",
                          command: command("mlens.previewPbipApply", vscode.l10n.t("Review PBIP Changes")),
                      })
                    : item(vscode.l10n.t("In sync with the PBIP project"), {
                          description: vscode.l10n.t("no pending edits"),
                          icon: "pass",
                          color: "charts.green",
                      }),
            );
        } else {
            nodes.push(
                item(vscode.l10n.t("Queries"), {
                    description: vscode.l10n.t("{0} .pq/.m files", report.queryFiles.length),
                    icon: "symbol-function",
                }),
            );
        }

        if (report.sensitiveFindings.length > 0) {
            nodes.push(
                item(vscode.l10n.t("Possible secrets in queries"), {
                    description: String(report.sensitiveFindings.length),
                    tooltip: vscode.l10n.t("Text that looks like a password or token. Open Problems to see where."),
                    icon: "warning",
                    color: "problemsWarningIcon.foreground",
                    command: command("workbench.actions.view.problems", vscode.l10n.t("Show Problems")),
                }),
            );
        }

        if (process.platform !== "win32") {
            nodes.push(item(vscode.l10n.t("Data preview"), { description: vscode.l10n.t("Windows only"), icon: "circle-slash" }));
        } else if (report.pqTestPath === undefined) {
            nodes.push(
                item(vscode.l10n.t("Set up data preview"), {
                    description: vscode.l10n.t("needs the Power Query SDK"),
                    tooltip: vscode.l10n.t("Install the Power Query SDK extension to run queries and see their data."),
                    icon: "extensions",
                    command: command("workbench.extensions.search", vscode.l10n.t("Install Power Query SDK"), ["powerquery.vscode-powerquery-sdk"]),
                }),
            );
        } else {
            nodes.push(
                item(vscode.l10n.t("Preview query data"), {
                    description: vscode.l10n.t("current .pq file"),
                    icon: "play",
                    command: command("mlens.evaluateQuery", vscode.l10n.t("Preview Query Data")),
                }),
            );
        }

        nodes.push(
            item(vscode.l10n.t("Workspace report"), {
                description: vscode.l10n.t("sources, secrets, dependencies"),
                icon: "graph",
                command: command("mlens.showWorkspaceReport", vscode.l10n.t("Show Workspace Report")),
            }),
        );

        return nodes;
    }
}

function sourceIcon(functionName: string): string {
    if (/^(File|Folder|Csv|Excel|Json|Xml)\./.test(functionName)) {
        return "file";
    }

    if (/^(Web|OData|SharePoint)\./.test(functionName)) {
        return "globe";
    }

    return "database";
}

class DataSourcesProvider implements vscode.TreeDataProvider<Node> {
    private readonly changed: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData: vscode.Event<void> = this.changed.event;

    constructor(private readonly cache: ReportCache) {
        cache.onDidChange(() => this.changed.fire());
    }

    getTreeItem(element: Node): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: Node): Promise<Node[]> {
        if (element !== undefined) {
            return element.children ?? [];
        }

        const report: WorkspaceReport | undefined = await this.cache.get();
        const groups: Map<string, DataSourceFinding[]> = new Map();

        for (const source of report?.dataSources ?? []) {
            groups.set(source.functionName, [...(groups.get(source.functionName) ?? []), source]);
        }

        return [...groups.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([functionName, sources]) =>
                item(functionName, {
                    description: String(sources.length),
                    icon: sourceIcon(functionName),
                    children: sources.map((source: DataSourceFinding) =>
                        item(source.detail, {
                            description: `${path.posix.basename(source.file)}:${source.line}`,
                            tooltip: `${source.functionName}(${source.detail})\n${source.file}:${source.line}`,
                            command: openAt(source.uri, source.line),
                        }),
                    ),
                }),
            );
    }
}

class DependenciesProvider implements vscode.TreeDataProvider<Node> {
    private readonly changed: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData: vscode.Event<void> = this.changed.event;

    constructor(private readonly cache: ReportCache) {
        cache.onDidChange(() => this.changed.fire());
    }

    getTreeItem(element: Node): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: Node): Promise<Node[]> {
        if (element !== undefined) {
            return element.children ?? [];
        }

        const report: WorkspaceReport | undefined = await this.cache.get();
        const byName: Map<string, vscode.Uri> = new Map(
            (report?.queryFiles ?? []).map((file) => [file.name, file.uri] as [string, vscode.Uri]),
        );

        return (report?.dependencies ?? []).map((dependency: QueryDependency) => {
            const node: Node = item(dependency.query, {
                description: vscode.l10n.t("depends on {0}", dependency.dependsOn.length),
                icon: "symbol-function",
                command: openAt(dependency.uri),
                children: dependency.dependsOn.map((name: string) => {
                    const uri: vscode.Uri | undefined = byName.get(name);

                    return item(name, { icon: "arrow-small-right", command: uri !== undefined ? openAt(uri) : undefined });
                }),
            });

            node.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;

            return node;
        });
    }
}

export function registerSidebar(context: vscode.ExtensionContext): () => void {
    const cache: ReportCache = new ReportCache();
    let timer: NodeJS.Timeout | undefined;

    const scheduleRefresh = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
        }

        timer = setTimeout(() => {
            timer = undefined;
            cache.invalidate();
        }, REFRESH_DEBOUNCE_MS);
    };

    const watcher: vscode.FileSystemWatcher = vscode.workspace.createFileSystemWatcher("**/*.{pq,m,tmdl,pbip}");
    const mapWatcher: vscode.FileSystemWatcher = vscode.workspace.createFileSystemWatcher("**/.mlens/pbip-map.json");

    for (const fileWatcher of [watcher, mapWatcher]) {
        fileWatcher.onDidChange(scheduleRefresh);
        fileWatcher.onDidCreate(scheduleRefresh);
        fileWatcher.onDidDelete(scheduleRefresh);
    }

    context.subscriptions.push(
        cache,
        watcher,
        mapWatcher,
        vscode.window.createTreeView("mlens.overview", { treeDataProvider: new OverviewProvider(cache) }),
        vscode.window.createTreeView("mlens.dataSources", { treeDataProvider: new DataSourcesProvider(cache) }),
        vscode.window.createTreeView("mlens.dependencies", { treeDataProvider: new DependenciesProvider(cache) }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => cache.invalidate()),
        vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
            if (event.affectsConfiguration("mlens")) {
                scheduleRefresh();
            }
        }),
        vscode.extensions.onDidChange(scheduleRefresh),
        { dispose: () => timer !== undefined && clearTimeout(timer) },
    );

    return () => cache.invalidate();
}
