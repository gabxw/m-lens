// Confere as traduções: toda string de vscode.l10n.t(...) em src/ precisa existir no
// pacote pt-BR com os mesmos marcadores {0}, {1}...; o mesmo para package.nls*.json.
// Com --dump, imprime as chaves que faltam (com o texto em inglês) para facilitar a tradução.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dump = process.argv.includes("--dump");

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });
}

function unquote(literal) {
    const quote = literal[0];
    const body = literal.slice(1, -1);

    if (quote === '"') {
        return JSON.parse(literal);
    }

    return JSON.parse(`"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
}

const callPattern = /\bl10n\.t\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
const keys = new Set();

for (const file of walk(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    let match;

    while ((match = callPattern.exec(text)) !== null) {
        keys.add(unquote(match[1]));
    }

    if (/\bl10n\.t\(\s*`/.test(text)) {
        console.error(`${file}: use aspas simples ou duplas em l10n.t — template literal não é extraído.`);
        process.exitCode = 1;
    }
}

const placeholders = (value) => [...value.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(",");
const failures = [];

function compare(label, sourceKeys, translated, sourceText = (key) => key) {
    const missing = [];

    for (const key of sourceKeys) {
        if (!(key in translated)) {
            missing.push(key);
        } else if (placeholders(sourceText(key)) !== placeholders(translated[key])) {
            failures.push(`${label}: marcadores diferentes em "${key}"`);
        }
    }

    for (const key of Object.keys(translated)) {
        if (!sourceKeys.has(key)) {
            failures.push(`${label}: chave sem uso "${key}"`);
        }
    }

    if (missing.length > 0) {
        failures.push(`${label}: ${missing.length} sem tradução`);

        if (dump) {
            console.log(JSON.stringify(Object.fromEntries(missing.map((key) => [key, sourceText(key)])), null, 2));
        } else {
            missing.slice(0, 10).forEach((key) => failures.push(`  - ${key}`));
        }
    }
}

const bundle = JSON.parse(readFileSync(join(root, "l10n", "bundle.l10n.pt-br.json"), "utf8"));
compare("l10n/bundle.l10n.pt-br.json", keys, bundle);

const nls = JSON.parse(readFileSync(join(root, "package.nls.json"), "utf8"));
const nlsPt = JSON.parse(readFileSync(join(root, "package.nls.pt-br.json"), "utf8"));
compare("package.nls.pt-br.json", new Set(Object.keys(nls)), nlsPt, (key) => nls[key]);

const manifest = readFileSync(join(root, "package.json"), "utf8");

for (const [, key] of manifest.matchAll(/"%([^%"]+)%"/g)) {
    if (!(key in nls)) {
        failures.push(`package.json usa %${key}% que não existe em package.nls.json`);
    }
}

if (failures.length > 0) {
    console.error(`L10N FALHOU (${keys.size} strings no código):\n${failures.join("\n")}`);
    process.exit(1);
}

console.log(`L10N OK — ${keys.size} strings traduzidas`);
