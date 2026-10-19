/**
 * Geração de M para o preview — módulo puro, sem vscode.
 *
 * Credenciais de API ficam disponíveis no preview via `MLens_GetCredential("Nome")`.
 * Só as credenciais que a query realmente referencia entram no arquivo temporário.
 * Logins SQL não passam por aqui: vão direto para o cache de credenciais do PQTest.
 */
export type PreviewCredentialKind = "api-key" | "bearer" | "basic" | "key-value";

export interface PreviewCredentialMaterial {
    readonly name: string;
    readonly kind: PreviewCredentialKind;
    readonly values: Readonly<Record<string, string>>;
}

export interface SqlDataSource {
    readonly server: string;
    readonly database: string;
}

function mText(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function mFieldName(value: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : `#"${value.replace(/"/g, '""')}"`;
}

function indent(text: string, spaces: number): string {
    const prefix: string = " ".repeat(spaces);

    return text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line: string) => (line === "" ? "" : `${prefix}${line}`))
        .join("\n");
}

function renderCredentialRecord(credential: PreviewCredentialMaterial): string {
    const fields: string[] = [`Kind = ${mText(credential.kind)}`];

    for (const [field, value] of Object.entries(credential.values)) {
        fields.push(`${mFieldName(field)} = ${mText(value)}`);
    }

    return `${mFieldName(credential.name)} = [${fields.join(", ")}]`;
}

function unescapeMText(value: string): string {
    return value.replace(/""/g, '"');
}

/** Nomes usados em `MLens_GetCredential("Nome")`. */
export function referencedCredentialNames(queryText: string): Set<string> {
    const names: Set<string> = new Set();
    const pattern: RegExp = /\bMLens_GetCredential\s*\(\s*"((?:""|[^"])*)"\s*\)/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(queryText)) !== null) {
        names.add(unescapeMText(match[1]));
    }

    return names;
}

/** `Sql.Database("servidor", "banco")` com literais — as fontes SQL que a query vai abrir. */
export function extractSqlDataSources(queryText: string): SqlDataSource[] {
    const found: SqlDataSource[] = [];
    const seen: Set<string> = new Set();
    const pattern: RegExp = /\bSql\.Database\s*\(\s*"((?:""|[^"])*)"\s*,\s*"((?:""|[^"])*)"/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(queryText)) !== null) {
        const source: SqlDataSource = {
            server: unescapeMText(match[1]).trim(),
            database: unescapeMText(match[2]).trim(),
        };
        const key: string = sqlSourceKey(source);

        if (source.server !== "" && source.database !== "" && !seen.has(key)) {
            seen.add(key);
            found.push(source);
        }
    }

    return found;
}

export function sqlSourceKey(source: SqlDataSource): string {
    return `${source.server.toLowerCase()};${source.database.toLowerCase()}`;
}

/** `section Section1; shared X = ...` — documento inteiro do PBIX, não uma query avulsa. */
export function isSectionDocument(queryText: string): boolean {
    return /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*section\s/i.test(queryText);
}

export function wrapQueryWithCredentials(
    queryText: string,
    credentials: readonly PreviewCredentialMaterial[],
): string {
    const used: Set<string> = referencedCredentialNames(queryText);
    const injected: PreviewCredentialMaterial[] = credentials.filter((credential: PreviewCredentialMaterial) =>
        used.has(credential.name),
    );

    if (injected.length === 0 && used.size === 0) {
        return queryText;
    }

    const credentialBlock: string =
        injected.length === 0
            ? "    MLensCredentials = [],"
            : `    MLensCredentials = [
${injected.map((credential: PreviewCredentialMaterial) => `        ${renderCredentialRecord(credential)}`).join(",\n")}
    ],`;

    return `let
${credentialBlock}
    MLens_GetCredential = (name as text) as record =>
        if Record.HasFields(MLensCredentials, name)
        then Record.Field(MLensCredentials, name)
        else error "M Lens: no preview credential named " & name & ". Add it with M Lens: Manage Preview Credentials.",
    MLens_Result = (
${indent(queryText.trim(), 8)}
    )
in
    MLens_Result
`;
}

export function renderCredentialSnippet(credential: PreviewCredentialMaterial): string {
    const name: string = credential.name.replace(/"/g, '""');
    const note: string = "// MLens_GetCredential only exists in M Lens previews. Use Power Query credentials in Power BI.";

    switch (credential.kind) {
        case "bearer":
            return `${note}
cred = MLens_GetCredential("${name}"),
Source = Web.Contents("https://api.example.com/endpoint", [
    Headers = [Authorization = "Bearer " & cred[Token]]
])`;

        case "api-key":
            return `${note}
cred = MLens_GetCredential("${name}"),
Source = Web.Contents("https://api.example.com/endpoint", [
    Headers = Record.FromList({cred[Value]}, {cred[HeaderName]})
])`;

        case "basic":
            return `${note}
cred = MLens_GetCredential("${name}"),
basicToken = Binary.ToText(Text.ToBinary(cred[Username] & ":" & cred[Password]), BinaryEncoding.Base64),
Source = Web.Contents("https://api.example.com/endpoint", [
    Headers = [Authorization = "Basic " & basicToken]
])`;

        case "key-value":
            return `${note}
cred = MLens_GetCredential("${name}"),
secretValue = cred[Value]`;
    }
}
