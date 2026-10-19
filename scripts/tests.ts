import assert from "node:assert/strict";

import { lintDocument, maskComments, RuleId } from "../src/lint/lint";
import { applyBlockToText, extractBlocks } from "../src/pbip/tmdlCore";
import { extractSqlDataSources, isSectionDocument, wrapQueryWithCredentials } from "../src/preview/credentialM";

async function testLintRules(): Promise<void> {
    const text: string = `let
    Source = Csv.Document(File.Contents("C:\\Dados\\vendas.csv")),
    Custom1 = Table.RemoveColumns(Source, {"Temp"}),
    Token = "Bearer abc123",
    Local = Web.Contents("http://localhost:3000/api?x=1"),
    Unused = Table.Buffer(Custom1),
    Resultado = Custom1
in
    Resultado
`;

    const findings = await lintDocument(text);
    const rules: Set<RuleId> = new Set(findings.map((finding) => finding.ruleId));

    assert.ok(rules.has("hardcoded-path"), "detecta caminho local hardcoded");
    assert.ok(rules.has("generic-step-name"), "detecta nome de step genérico");
    assert.ok(rules.has("table-buffer"), "detecta Table.Buffer");
    assert.ok(rules.has("unused-step"), "detecta step não usado");
    assert.ok(rules.has("sensitive-literal"), "detecta possível token");
    assert.ok(rules.has("localhost-source"), "detecta fonte localhost");
    assert.ok(rules.has("web-contents-options"), "detecta Web.Contents com query string");
    assert.ok(rules.has("remove-columns-risk"), "detecta Table.RemoveColumns");
}

async function testSensitiveLiteral(): Promise<void> {
    const safe: string = `let
    Source = Table.SelectColumns(Fonte, {"token_id", "Password Reset Date", "Secretaria", "Senha alterada"})
in
    Source
`;

    const safeFindings = await lintDocument(safe);

    assert.ok(
        !safeFindings.some((finding) => finding.ruleId === "sensitive-literal"),
        "nome de coluna não é segredo",
    );

    for (const literal of [
        `"Server=srv;Database=dw;User Id=bi;Password=Abc123!"`,
        `"https://api.exemplo.com/v1?api_key=9f8e7d6c5b"`,
        `"Bearer abc123def"`,
    ]) {
        const findings = await lintDocument(`let\n    Source = ${literal}\nin\n    Source\n`);

        assert.ok(findings.some((finding) => finding.ruleId === "sensitive-literal"), `detecta segredo em ${literal}`);
    }
}

function testTmdlRoundTrip(): void {
    const tmdl: string = `table Vendas
\tpartition Vendas = m
\t\tmode: import
\t\tsource =
\t\t\tlet
\t\t\t\tSource = Csv.Document(File.Contents("C:\\Dados\\vendas.csv"))
\t\t\tin
\t\t\t\tSource
`;

    const blocks = extractBlocks(tmdl);

    assert.equal(blocks.length, 1, "extrai um bloco M");
    assert.equal(blocks[0].name, "Vendas");
    assert.equal(blocks[0].kind, "partition-source");

    const updated = applyBlockToText(
        tmdl,
        "Vendas",
        "partition-source",
        `let
    Source = Csv.Document(File.Contents("C:\\Dados\\vendas.csv")),
    Resultado = Table.SelectRows(Source, each true)
in
    Resultado`,
    );

    assert.ok(updated !== undefined, "aplica bloco de volta");
    assert.match(updated ?? "", /Resultado = Table\.SelectRows/);
}

function testTmdlExpressionsRoundTrip(): void {
    // Layout real do Power BI Desktop: corpo M com 2 tabs, metadados com 1 tab, CRLF.
    const tmdl: string = [
        `expression Servidor = "srv-sql01" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]`,
        "\tlineageTag: 11111111-aaaa",
        "\tqueryGroup: Parametros",
        "",
        "\tannotation PBI_ResultType = Text",
        "",
        "expression 'Transformar Arquivo' =",
        "\t\tlet",
        "\t\t    Fonte = (Arquivo as binary) => Excel.Workbook(Arquivo, null, true)",
        "\t\tin",
        "\t\t    Fonte",
        "\tmAttributes: [ FunctionQueryBinding = \"{}\" ]",
        "\tlineageTag: 22222222-bbbb",
        "\tqueryGroup: 'Auxiliares\Funções'",
        "",
        "\tannotation PBI_ResultType = Function",
        "",
    ].join("\r\n");

    const blocks = extractBlocks(tmdl);

    assert.equal(blocks.length, 2, "extrai as duas expressions");
    assert.equal(blocks[0].code, `"srv-sql01" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]`);
    assert.equal(
        blocks[1].code,
        "let\n    Fonte = (Arquivo as binary) => Excel.Workbook(Arquivo, null, true)\nin\n    Fonte",
        "corpo M sem metadados TMDL",
    );

    let unchanged: string = tmdl;

    for (const block of blocks) {
        unchanged = applyBlockToText(unchanged, block.name, block.kind, block.code) ?? "";
    }

    assert.equal(unchanged, tmdl, "reaplicar sem editar não altera o arquivo");

    const edited = applyBlockToText(
        tmdl,
        "Transformar Arquivo",
        "expression",
        "let\r\n    Fonte = (Arquivo as binary) => Excel.Workbook(Arquivo, null, true),\r\n    Extra = 1\r\nin\r\n    Fonte\r\n",
    ) ?? "";

    assert.ok(edited.includes("\t\t    Extra = 1\r\n"), "aplica a edição com a indentação do arquivo");
    assert.ok(!/[^\r]\n/.test(edited), "preserva CRLF");
    assert.ok(edited.includes("expression 'Transformar Arquivo' =\r\n"), "preserva o cabeçalho original");

    for (const tag of ["mAttributes:", "lineageTag: 22222222-bbbb", "queryGroup: 'Auxiliares\Funções'", "annotation PBI_ResultType = Function"]) {
        assert.ok(edited.includes(`\t${tag}`), `preserva ${tag}`);
    }

    const param = applyBlockToText(tmdl, "Servidor", "expression", `"srv-sql02" meta [IsParameterQuery=true]`) ?? "";

    assert.ok(param.startsWith(`expression Servidor = "srv-sql02" meta [IsParameterQuery=true]\r\n\tlineageTag: 11111111-aaaa`), "parâmetro continua em uma linha");
}

function testCredentialInjection(): void {
    const credentials = [
        { name: "Sales API", kind: "bearer" as const, values: { Token: "abc" } },
        { name: "Other API", kind: "api-key" as const, values: { HeaderName: "x-api-key", Value: "zzz" } },
    ];

    const plain: string = "let\n    Source = Sql.Database(\"srv\", \"dw\")\nin\n    Source";

    assert.equal(wrapQueryWithCredentials(plain, credentials), plain, "query sem MLens_GetCredential não é embrulhada");

    const wrapped: string = wrapQueryWithCredentials(
        'let\n    cred = MLens_GetCredential("Sales API"),\n    Source = cred[Token]\nin\n    Source',
        credentials,
    );

    assert.match(wrapped, /#"Sales API" = \[Kind = "bearer", Token = "abc"\]/, "injeta a credencial referenciada");
    assert.ok(!wrapped.includes("zzz"), "não injeta credenciais que a query não usa");

    assert.deepEqual(
        extractSqlDataSources('let\n    A = Sql.Database("SRV01", "Sales"),\n    B = Sql.Database("srv01", "sales")\nin\n    A'),
        [{ server: "SRV01", database: "Sales" }],
        "fontes SQL literais, sem duplicar por maiúsculas",
    );

    assert.ok(isSectionDocument("// export\nsection Section1;\nshared Q = 1;"), "reconhece documento de section");
    assert.ok(!isSectionDocument("let\n    Source = 1\nin\n    Source"), "query comum não é section");
}

async function testLintRefinements(): Promise<void> {
    const ruleIds = async (text: string): Promise<RuleId[]> => (await lintDocument(text)).map((finding) => finding.ruleId);

    assert.ok(
        (await ruleIds('let\n    #"Tipo Alterado1" = Table.TransformColumnTypes(Fonte, {}),\n    Fonte = 1\nin\n    #"Tipo Alterado1"')).includes(
            "generic-step-name",
        ),
        "nome genérico em português",
    );

    assert.ok(
        !(await ruleIds('"C:\\Dados" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]')).includes("hardcoded-path"),
        "parâmetro com caminho não é apontado",
    );

    assert.ok(
        !(await ruleIds('let\n    // Source = Table.RemoveColumns(x, {"a"})\n    Source = 1\nin\n    Source')).includes("remove-columns-risk"),
        "padrões em comentário são ignorados",
    );

    const masked: string = maskComments('a = "http://x" // c\n/* b */ z');

    assert.equal(masked, 'a = "http://x"     \n        z', "maskComments preserva strings e posições");
}

await testLintRules();
await testSensitiveLiteral();
await testLintRefinements();
testTmdlRoundTrip();
testTmdlExpressionsRoundTrip();
testCredentialInjection();

console.log("M Lens tests passed");
