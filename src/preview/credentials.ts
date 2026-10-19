/**
 * Credenciais do preview de dados.
 *
 * - Logins SQL: um por servidor/banco, guardados no cofre do VS Code (secrets) e
 *   registrados no cache do PQTest apenas para a fonte a que pertencem. Quando o
 *   PQTest pede credencial para um servidor sem login salvo, o usuário escolhe na hora.
 * - Credenciais de API (Bearer, API key, Basic, chave/valor): lidas na query com
 *   `MLens_GetCredential("Nome")`, injetadas só no arquivo temporário do preview.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { logInfo } from "../log";
import { getTargetQueryEditor } from "../util/editor";
import { showReadOnlyMarkdown } from "../util/markdown";
import {
    extractSqlDataSources,
    PreviewCredentialKind,
    PreviewCredentialMaterial,
    referencedCredentialNames,
    renderCredentialSnippet,
    SqlDataSource,
    sqlSourceKey,
    wrapQueryWithCredentials,
} from "./credentialM";

interface StoredCredentialMeta {
    readonly id: string;
    readonly name: string;
    readonly kind: PreviewCredentialKind;
    readonly updatedAt: string;
}

interface SqlLoginMeta {
    readonly id: string;
    readonly server: string;
    readonly database: string;
    readonly username: string;
    readonly updatedAt: string;
}

interface CredentialField {
    readonly key: string;
    readonly label: string;
    readonly password?: boolean;
    readonly defaultValue?: string;
}

const META_KEY: string = "mlens.preview.credentials";
const SQL_LOGINS_KEY: string = "mlens.preview.sqlLogins";

// Formato da 0.1.x: um único login SQL por workspace, migrado na ativação.
const LEGACY_SQL_META_KEY: string = "mlens.preview.sqlCredential";
const LEGACY_SQL_PASSWORD_SECRET_KEY: string = "previewSqlCredential.Password";

function kindLabel(kind: PreviewCredentialKind): string {
    switch (kind) {
        case "api-key":
            return vscode.l10n.t("API key");
        case "bearer":
            return vscode.l10n.t("Bearer token");
        case "basic":
            return vscode.l10n.t("User name and password");
        case "key-value":
            return vscode.l10n.t("Generic secret");
    }
}

function kindFields(kind: PreviewCredentialKind): readonly CredentialField[] {
    switch (kind) {
        case "api-key":
            return [
                { key: "HeaderName", label: vscode.l10n.t("Header name"), defaultValue: "x-api-key" },
                { key: "Value", label: vscode.l10n.t("API key value"), password: true },
            ];
        case "bearer":
            return [{ key: "Token", label: vscode.l10n.t("Bearer token"), password: true }];
        case "basic":
            return [
                { key: "Username", label: vscode.l10n.t("User name") },
                { key: "Password", label: vscode.l10n.t("Password"), password: true },
            ];
        case "key-value":
            return [
                { key: "Key", label: vscode.l10n.t("Key name") },
                { key: "Value", label: vscode.l10n.t("Value"), password: true },
            ];
    }
}

function secretKey(id: string, field: string): string {
    return `previewCredential.${id}.${field}`;
}

function sqlSecretKey(id: string): string {
    return `previewSqlLogin.${id}.Password`;
}

function createId(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readMeta(context: vscode.ExtensionContext): StoredCredentialMeta[] {
    return context.workspaceState.get<StoredCredentialMeta[]>(META_KEY, []);
}

async function writeMeta(context: vscode.ExtensionContext, metas: readonly StoredCredentialMeta[]): Promise<void> {
    await context.workspaceState.update(META_KEY, [...metas]);
}

function readSqlLogins(context: vscode.ExtensionContext): SqlLoginMeta[] {
    return context.globalState.get<SqlLoginMeta[]>(SQL_LOGINS_KEY, []);
}

async function writeSqlLogins(context: vscode.ExtensionContext, logins: readonly SqlLoginMeta[]): Promise<void> {
    await context.globalState.update(SQL_LOGINS_KEY, [...logins]);
}

function sqlLoginLabel(login: { readonly server: string; readonly database: string }): string {
    return `${login.server} / ${login.database}`;
}

async function saveSqlLogin(
    context: vscode.ExtensionContext,
    source: SqlDataSource,
    username: string,
    password: string,
): Promise<void> {
    const key: string = sqlSourceKey(source);
    const others: SqlLoginMeta[] = readSqlLogins(context).filter((login: SqlLoginMeta) => sqlSourceKey(login) !== key);
    const previous: SqlLoginMeta | undefined = readSqlLogins(context).find((login: SqlLoginMeta) => sqlSourceKey(login) === key);
    const id: string = previous?.id ?? createId();

    await context.secrets.store(sqlSecretKey(id), password);
    await writeSqlLogins(context, [
        ...others,
        { id, server: source.server, database: source.database, username, updatedAt: new Date().toISOString() },
    ]);
}

/** Converte o login SQL único da 0.1.x (por workspace) para o formato por servidor/banco. */
export async function migrateLegacySqlCredential(context: vscode.ExtensionContext): Promise<void> {
    const legacy: { server?: string; database?: string; username?: string } | undefined =
        context.workspaceState.get(LEGACY_SQL_META_KEY);

    if (legacy === undefined) {
        return;
    }

    const password: string | undefined = await context.secrets.get(LEGACY_SQL_PASSWORD_SECRET_KEY);

    if (legacy.server && legacy.database && legacy.username && password !== undefined) {
        await saveSqlLogin(context, { server: legacy.server, database: legacy.database }, legacy.username, password);
        logInfo(`Credentials: migrated the SQL login for ${legacy.server} / ${legacy.database}.`);
    }

    await context.workspaceState.update(LEGACY_SQL_META_KEY, undefined);
    // O segredo antigo era global e pode ainda servir a outro workspace não migrado; fica no cofre.
}

function runPqTestCommandWithInput(pqTestPath: string, args: readonly string[], input: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(pqTestPath, [...args], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout: string = "";
        let stderr: string = "";

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code: number | null) => {
            if (code !== 0) {
                reject(new Error(stderr.trim() !== "" ? stderr : stdout));
                return;
            }

            resolve();
        });

        child.stdin.write(input);
        child.stdin.end();
    });
}

type AuthenticationKind = "UsernamePassword" | "Windows" | "Anonymous";

async function setCredential(
    pqTestPath: string,
    cachePath: string,
    dataSourceKind: string,
    dataSourcePath: string,
    authenticationKind: AuthenticationKind,
    properties: Record<string, string> = {},
): Promise<void> {
    await runPqTestCommandWithInput(
        pqTestPath,
        [
            "set-credential",
            "--dataSourceKind",
            dataSourceKind,
            "--dataSourcePath",
            dataSourcePath,
            "--CredentialsFilePath",
            cachePath,
        ],
        JSON.stringify({
            AuthenticationKind: authenticationKind,
            AuthenticationProperties: properties,
            PrivacySetting: "None",
            Permissions: [],
        }),
    );
    logInfo(`Credentials: registered ${authenticationKind} for ${dataSourceKind} ${dataSourcePath}.`);
}

/** Caminho único do cache de credenciais do PQTest (SQL, File, Web etc. coexistem nele). */
export async function getCredentialCachePath(context: vscode.ExtensionContext): Promise<string> {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);

    return path.join(context.globalStorageUri.fsPath, "pqtest-credentials.json");
}

async function clearCredentialCache(context: vscode.ExtensionContext): Promise<void> {
    const cachePath: string = await getCredentialCachePath(context);

    try {
        fs.unlinkSync(cachePath);
    } catch {
        // cache ainda não existia
    }
}

/** Registra no cache os logins SQL salvos — só para as fontes da query que têm login próprio. */
export async function registerSavedSqlLogins(
    context: vscode.ExtensionContext,
    pqTestPath: string,
    cachePath: string,
    queryText: string,
): Promise<number> {
    const logins: SqlLoginMeta[] = readSqlLogins(context);
    let count: number = 0;

    for (const source of extractSqlDataSources(queryText)) {
        const login: SqlLoginMeta | undefined = logins.find((item: SqlLoginMeta) => sqlSourceKey(item) === sqlSourceKey(source));
        const password: string | undefined = login === undefined ? undefined : await context.secrets.get(sqlSecretKey(login.id));

        if (login === undefined || password === undefined) {
            continue;
        }

        await setCredential(pqTestPath, cachePath, "SQL", `${source.server};${source.database}`, "UsernamePassword", {
            Username: login.username,
            Password: password,
        });
        count += 1;
    }

    return count;
}

async function askSqlLogin(source: SqlDataSource, username?: string): Promise<{ username: string; password: string } | undefined> {
    const user: string | undefined = await vscode.window.showInputBox({
        title: vscode.l10n.t("SQL login for {0}", sqlLoginLabel(source)),
        prompt: vscode.l10n.t("User name"),
        value: username,
        ignoreFocusOut: true,
        validateInput: (value: string) => (value.trim() === "" ? vscode.l10n.t("Enter a user name.") : undefined),
    });

    if (user === undefined) {
        return undefined;
    }

    const password: string | undefined = await vscode.window.showInputBox({
        title: vscode.l10n.t("SQL login for {0}", sqlLoginLabel(source)),
        prompt: vscode.l10n.t("Password (stored in the VS Code secret storage)"),
        password: true,
        ignoreFocusOut: true,
        validateInput: (value: string) => (value === "" ? vscode.l10n.t("Enter a password.") : undefined),
    });

    return password === undefined ? undefined : { username: user.trim(), password };
}

/**
 * O PQTest pediu credencial para uma fonte. File/Folder são resolvidos sem perguntar
 * (identidade Windows atual); SQL e Web perguntam ao usuário. Devolve true se uma
 * credencial foi registrada e vale tentar de novo.
 */
export async function resolveMissingCredential(
    context: vscode.ExtensionContext,
    pqTestPath: string,
    cachePath: string,
    kind: string,
    dataSourcePath: string,
): Promise<boolean> {
    if (kind === "File" || kind === "Folder") {
        await setCredential(pqTestPath, cachePath, kind, dataSourcePath, "Windows");

        return true;
    }

    type Choice = vscode.QuickPickItem & { readonly auth: AuthenticationKind };

    const options: Choice[] = [];

    if (kind === "SQL") {
        options.push({
            label: `$(account) ${vscode.l10n.t("SQL user name and password")}`,
            description: vscode.l10n.t("Saved for this server and database only"),
            auth: "UsernamePassword",
        });
    }

    if (kind === "Web") {
        options.push({
            label: `$(globe) ${vscode.l10n.t("Anonymous")}`,
            description: vscode.l10n.t("Public endpoints, or APIs that take the key in the query"),
            auth: "Anonymous",
        });
    }

    if (kind === "SQL" || kind === "Web") {
        options.push({
            label: `$(shield) ${vscode.l10n.t("Windows (current user)")}`,
            description: vscode.l10n.t("Integrated security with your Windows account"),
            auth: "Windows",
        });
    }

    if (options.length === 0) {
        return false;
    }

    const picked: Choice | undefined = await vscode.window.showQuickPick(options, {
        title: vscode.l10n.t("{0} needs a credential to preview this query", `${kind} · ${dataSourcePath}`),
        placeHolder: vscode.l10n.t("How should M Lens connect?"),
        ignoreFocusOut: true,
    });

    if (picked === undefined) {
        return false;
    }

    if (picked.auth !== "UsernamePassword") {
        await setCredential(pqTestPath, cachePath, kind, dataSourcePath, picked.auth);

        return true;
    }

    const [server, ...rest] = dataSourcePath.split(";");
    const source: SqlDataSource = { server, database: rest.join(";") };
    const login: { username: string; password: string } | undefined = await askSqlLogin(source);

    if (login === undefined) {
        return false;
    }

    await saveSqlLogin(context, source, login.username, login.password);
    await setCredential(pqTestPath, cachePath, "SQL", dataSourcePath, "UsernamePassword", {
        Username: login.username,
        Password: login.password,
    });

    return true;
}

async function pickCredentialKind(): Promise<PreviewCredentialKind | undefined> {
    type KindItem = vscode.QuickPickItem & { readonly credentialKind: PreviewCredentialKind };

    const picked: KindItem | undefined = await vscode.window.showQuickPick<KindItem>(
        [
            { label: kindLabel("bearer"), description: "Authorization: Bearer <token>", credentialKind: "bearer" },
            { label: kindLabel("api-key"), description: vscode.l10n.t("Custom header, e.g. x-api-key"), credentialKind: "api-key" },
            { label: kindLabel("basic"), description: vscode.l10n.t("Basic authentication"), credentialKind: "basic" },
            { label: kindLabel("key-value"), description: vscode.l10n.t("Any secret your query reads"), credentialKind: "key-value" },
        ],
        {
            title: vscode.l10n.t("M Lens: new API credential"),
            placeHolder: vscode.l10n.t("How does the API expect the secret?"),
        },
    );

    return picked?.credentialKind;
}

async function addApiCredential(context: vscode.ExtensionContext): Promise<void> {
    const kind: PreviewCredentialKind | undefined = await pickCredentialKind();

    if (kind === undefined) {
        return;
    }

    const name: string | undefined = await vscode.window.showInputBox({
        title: vscode.l10n.t("M Lens: credential name"),
        prompt: vscode.l10n.t('Your query reads it with MLens_GetCredential("name"). Example: Sales API'),
        ignoreFocusOut: true,
        validateInput: (value: string) => (value.trim() === "" ? vscode.l10n.t("Enter a name.") : undefined),
    });

    if (name === undefined) {
        return;
    }

    const id: string = createId();

    for (const field of kindFields(kind)) {
        const value: string | undefined = await vscode.window.showInputBox({
            title: `M Lens: ${name.trim()}`,
            prompt: `${kindLabel(kind)} · ${field.label}`,
            value: field.defaultValue,
            password: field.password === true,
            ignoreFocusOut: true,
            validateInput: (input: string) => (input.trim() === "" ? vscode.l10n.t("This field is required.") : undefined),
        });

        if (value === undefined) {
            return;
        }

        await context.secrets.store(secretKey(id, field.key), value);
    }

    await writeMeta(context, [
        ...readMeta(context).filter((meta: StoredCredentialMeta) => meta.name !== name.trim()),
        { id, name: name.trim(), kind, updatedAt: new Date().toISOString() },
    ]);

    const insert: string = vscode.l10n.t("Insert example");
    const choice: string | undefined = await vscode.window.showInformationMessage(
        vscode.l10n.t('M Lens: credential "{0}" saved in the VS Code secret storage.', name.trim()),
        insert,
    );

    if (choice === insert) {
        await insertCredentialSnippet(context, name.trim());
    }
}

async function materializeCredential(
    context: vscode.ExtensionContext,
    meta: StoredCredentialMeta,
): Promise<PreviewCredentialMaterial | undefined> {
    const values: Record<string, string> = {};

    for (const field of kindFields(meta.kind)) {
        const value: string | undefined = await context.secrets.get(secretKey(meta.id, field.key));

        if (value === undefined) {
            return undefined;
        }

        values[field.key] = value;
    }

    return { name: meta.name, kind: meta.kind, values };
}

async function insertCredentialSnippet(context: vscode.ExtensionContext, name: string): Promise<void> {
    const editor: vscode.TextEditor | undefined = await getTargetQueryEditor();
    const meta: StoredCredentialMeta | undefined = readMeta(context).find((item: StoredCredentialMeta) => item.name === name);

    if (editor === undefined || meta === undefined) {
        void vscode.window.showWarningMessage(vscode.l10n.t("M Lens: open a .pq file to insert the example."));

        return;
    }

    const material: PreviewCredentialMaterial | undefined = await materializeCredential(context, meta);

    if (material === undefined) {
        void vscode.window.showWarningMessage(vscode.l10n.t("M Lens: this credential is incomplete. Remove it and add it again."));

        return;
    }

    await editor.insertSnippet(new vscode.SnippetString(renderCredentialSnippet(material).replace(/\$/g, "\\$")));
}

async function removeApiCredential(context: vscode.ExtensionContext, meta: StoredCredentialMeta): Promise<void> {
    for (const field of kindFields(meta.kind)) {
        await context.secrets.delete(secretKey(meta.id, field.key));
    }

    await writeMeta(context, readMeta(context).filter((item: StoredCredentialMeta) => item.id !== meta.id));
}

async function removeSqlLogin(context: vscode.ExtensionContext, login: SqlLoginMeta): Promise<void> {
    await context.secrets.delete(sqlSecretKey(login.id));
    await writeSqlLogins(context, readSqlLogins(context).filter((item: SqlLoginMeta) => item.id !== login.id));
    // O cache do PQTest também guarda a senha; sem limpá-lo o login continuaria valendo.
    await clearCredentialCache(context);
}

async function confirm(message: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
}

export async function showCredentialGuide(): Promise<void> {
    await showReadOnlyMarkdown(
        "credentials",
        [
            `# ${vscode.l10n.t("M Lens preview credentials")}`,
            "",
            vscode.l10n.t("Credentials are only used by **M Lens: Preview Query Data**. Secrets stay in the VS Code secret storage and in the credential cache of PQTest, in the M Lens storage folder."),
            "",
            `## ${vscode.l10n.t("Databases and files")}`,
            "",
            vscode.l10n.t("Write the real server and database in the query, for example `Sql.Database(\"sql01\", \"Sales\")`. When the preview needs a login, M Lens asks for it and saves it for that server and database only. Local files and folders use your Windows account automatically."),
            "",
            `## ${vscode.l10n.t("APIs")}`,
            "",
            vscode.l10n.t("Add an API credential, then read it in the query with `MLens_GetCredential(\"Name\")`. Only credentials the query references are injected into the temporary preview file."),
            "",
            "```powerquery",
            "let",
            '    cred = MLens_GetCredential("Sales API"),',
            '    Source = Json.Document(Web.Contents("https://api.example.com/sales", [',
            '        Headers = [Authorization = "Bearer " & cred[Token]]',
            "    ]))",
            "in",
            "    Source",
            "```",
            "",
            `> ${vscode.l10n.t("`MLens_GetCredential` only exists in M Lens previews. M Lens will not apply a query that uses it to your PBIP project; in Power BI, configure the credential in Data source settings instead.")}`,
            "",
            `## ${vscode.l10n.t("Limitations")}`,
            "",
            vscode.l10n.t("Sources that use organizational (OAuth) sign-in, such as SharePoint Online, still need a credential set up with the Power Query SDK."),
            "",
        ].join("\n"),
    );
}

export async function managePreviewCredentials(context: vscode.ExtensionContext): Promise<void> {
    type Item = vscode.QuickPickItem & { readonly action?: () => Promise<void> };

    const items: Item[] = [];
    const logins: SqlLoginMeta[] = readSqlLogins(context);
    const metas: StoredCredentialMeta[] = readMeta(context);

    if (logins.length > 0) {
        items.push({ label: vscode.l10n.t("SQL logins"), kind: vscode.QuickPickItemKind.Separator });

        for (const login of logins) {
            items.push({
                label: `$(database) ${sqlLoginLabel(login)}`,
                description: login.username,
                action: async () => {
                    const replace: string = vscode.l10n.t("Change user or password");
                    const remove: string = vscode.l10n.t("Remove");
                    const choice: string | undefined = await vscode.window.showQuickPick([replace, remove], {
                        title: sqlLoginLabel(login),
                    });

                    if (choice === replace) {
                        const updated = await askSqlLogin(login, login.username);

                        if (updated !== undefined) {
                            await saveSqlLogin(context, login, updated.username, updated.password);
                            await clearCredentialCache(context);
                        }
                    } else if (choice === remove && (await confirm(vscode.l10n.t("Remove the SQL login for {0}?", sqlLoginLabel(login)), remove))) {
                        await removeSqlLogin(context, login);
                    }
                },
            });
        }
    }

    if (metas.length > 0) {
        items.push({ label: vscode.l10n.t("API credentials (this workspace)"), kind: vscode.QuickPickItemKind.Separator });

        for (const meta of metas) {
            items.push({
                label: `$(key) ${meta.name}`,
                description: kindLabel(meta.kind),
                action: async () => {
                    const insert: string = vscode.l10n.t("Insert example in the query");
                    const remove: string = vscode.l10n.t("Remove");
                    const choice: string | undefined = await vscode.window.showQuickPick([insert, remove], { title: meta.name });

                    if (choice === insert) {
                        await insertCredentialSnippet(context, meta.name);
                    } else if (choice === remove && (await confirm(vscode.l10n.t('Remove the credential "{0}"?', meta.name), remove))) {
                        await removeApiCredential(context, meta);
                    }
                },
            });
        }
    }

    items.push(
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: `$(add) ${vscode.l10n.t("Add API credential…")}`, action: () => addApiCredential(context) },
        {
            label: `$(clear-all) ${vscode.l10n.t("Clear cached data source credentials")}`,
            description: vscode.l10n.t("Windows, anonymous and SQL entries in the PQTest cache"),
            action: async () => {
                await clearCredentialCache(context);
                void vscode.window.showInformationMessage(vscode.l10n.t("M Lens: cached data source credentials cleared."));
            },
        },
        { label: `$(book) ${vscode.l10n.t("How preview credentials work")}`, action: () => showCredentialGuide() },
    );

    const picked: Item | undefined = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("M Lens: preview credentials"),
        placeHolder:
            logins.length + metas.length === 0
                ? vscode.l10n.t("No saved credentials yet. SQL logins are requested automatically during preview.")
                : vscode.l10n.t("Select a credential to change or remove it"),
    });

    await picked?.action?.();
}

export async function buildPreviewQueryWithCredentials(
    context: vscode.ExtensionContext,
    queryText: string,
): Promise<{ readonly text: string; readonly credentialCount: number }> {
    const enabled: boolean = vscode.workspace.getConfiguration("mlens").get<boolean>("preview.injectCredentials", true);

    if (!enabled) {
        return { text: queryText, credentialCount: 0 };
    }

    const materials: PreviewCredentialMaterial[] = [];

    for (const meta of readMeta(context)) {
        const material: PreviewCredentialMaterial | undefined = await materializeCredential(context, meta);

        if (material !== undefined) {
            materials.push(material);
        }
    }

    const referenced: Set<string> = referencedCredentialNames(queryText);

    return {
        text: wrapQueryWithCredentials(queryText, materials),
        credentialCount: materials.filter((material: PreviewCredentialMaterial) => referenced.has(material.name)).length,
    };
}
