# Contributing to M Lens

Thanks for helping. M Lens is a small TypeScript extension; you can be productive in a few minutes.

## Setup

```sh
git clone https://github.com/gabxw/m-lens.git
cd m-lens
npm install
```

Node.js 22 or later is required.

## Run the extension

Open the folder in VS Code and press **F5** (Run Extension). A new VS Code window opens with your build of M Lens. Open a Power BI Project (`.pbip`) folder there, or any folder with `.pq` files.

## Checks

```sh
npm run typecheck   # TypeScript
npm test            # unit tests, panel and TMDL smoke tests, translation check
npm run package     # builds an installable .vsix
```

`npm test` must pass before a pull request is merged. CI runs the same commands.

## Where things live

| Path | What it does |
|---|---|
| `src/lint/lint.ts` | Linter rules (pure, no `vscode` import, tested in Node) |
| `src/pbip/tmdlCore.ts` | TMDL extraction and write-back (pure, tested in Node) |
| `src/pbip/tmdl.ts` | PBIP commands: extract, review diff, apply with backup |
| `src/preview/` | Data preview through PQTest, credentials, result panel |
| `src/sidebar/projectView.ts` | Activity Bar views |
| `l10n/`, `package.nls*.json` | Translations |

## Translations

Every user-facing string in `src/` goes through `vscode.l10n.t("...")` (single or double quotes, not template literals). Strings in `package.json` use `%key%` entries from `package.nls.json`.

When you add or change a string, add the Portuguese translation to `l10n/bundle.l10n.pt-br.json` (or `package.nls.pt-br.json`). `npm test` fails if a translation is missing or its `{0}` placeholders differ. `node scripts/check-l10n.mjs --dump` prints the missing keys.

Adding a new language: create `l10n/bundle.l10n.<locale>.json` and `package.nls.<locale>.json` with the same keys.

## Test data

Never commit or attach real Power BI data. The `.gitignore` excludes `.pbix`, `.abf`, `mlens-queries/` and `.mlens/`. Tests use small made-up TMDL snippets in `scripts/tests.ts`.

## Pull requests

Keep them focused, describe what changed and how you tested it, and add a test when you fix a bug in the linter or the TMDL code.
