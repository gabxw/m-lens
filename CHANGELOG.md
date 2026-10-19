# Changelog

## 0.2.0

A new interface, in English and Portuguese.

- **English by default.** M Lens now follows the display language of VS Code: English, or Portuguese (Brazil) when VS Code is in Portuguese.
- **Sidebar instead of the dashboard.** A native M Lens view in the Activity Bar shows the project status and the next step (extract, review, apply), every data source, and query dependencies. It follows any color theme.
- **Review real diffs.** Review PBIP Changes opens a side-by-side diff of each `.tmdl` file instead of a list.
- **Data preview follows your theme** in light, dark and high contrast, with keyboard sorting and row selection, numbers aligned to the right, and a cancel button for long runs.
- **Simpler credentials.** Write the real server in `Sql.Database("server", "db")`; M Lens asks for a login when the preview needs one and saves it for that server and database only. Logins are never sent to other servers. Removing a login also clears it from the PQTest cache. Only the API credentials a query references are injected into the preview.
- **Safer apply.** Queries that use `MLens_GetCredential` (preview only) are never written to the PBIP project, and unsaved `.pq` edits are saved before applying.
- **Fewer, clearer commands**, all under the M Lens category. The workspace scan, data sources and dependency map are now one read-only Workspace Report. Old command IDs still work.
- Linter: generic step names in Portuguese (`Tipo Alterado1`), no hardcoded-path warning in parameter files, and rules no longer match inside comments.
- PQTest is found in VS Code Insiders, Cursor and other VS Code builds, and the search no longer blocks the editor.

Breaking: the `SQL_SERVER` / `SQL_DB` / `SQL_USER` / `SQL_PASS` placeholders are gone. A login saved in 0.1.x is migrated automatically.

## 0.1.1

Hotfix — please update.

- **Fixed: applying PBIP queries could wipe shared queries and parameters.** Multi-line `expression` blocks in `expressions.tmdl` (the layout Power BI Desktop writes) were extracted empty and written back empty. Extraction now reads the M body correctly, and applying keeps `lineageTag`, `queryGroup`, `mAttributes`, annotations, the original header and the file's line endings. Queries you did not edit are no longer rewritten.
- **Fixed: M Lens no longer changes your file icon theme.** The bundled "M Lens Icons" theme was set as the default and replaced the icons of every other file. It has been removed; `.pq`/`.m` files get a language icon instead, shown only when your icon theme has none.
- Extraction ignores M Lens backups in `.mlens/`, and old extraction maps pointing there are skipped.
- Extracting again asks before overwriting `.pq` files with edits not yet applied.
- `sensitive-literal` now flags actual secrets (`Password=...`, `api_key=...`, Bearer tokens, known key formats) instead of any text containing "token" or "password", and defaults to `warning`.

## 0.1.0

Versão inicial:

- Linter com 4 regras (`unused-step` com quick fix, `table-buffer`, `hardcoded-path`, `generic-step-name`)
- Extração e reaplicação de queries M em projetos PBIP (TMDL): partitions `= m` e expressions
- Extração somente leitura de queries de arquivos `.pbix` (DataMashup)
- Preview de dados experimental via PQTest (Power Query SDK)

Expansão da experiência:

- Painel visual do M Lens com ações principais para analistas de BI
- Suporte prático a arquivos `.m` além de `.pq`
- Pré-visualização da aplicação PBIP e backup automático de `.tmdl`
- Scanner de fontes de dados, mapa de dependências e diagnóstico do workspace
- Novas regras de lint para possíveis segredos, localhost, `Web.Contents` e `Table.RemoveColumns`
- Organizador leve da query atual
- Canal de logs `Output > M Lens`
- Ícone da extensão
- Testes básicos para linter e round-trip TMDL
- Preview formatado com busca, ordenação e painel de erro
- Painel simples para credenciais SQL (`SQL_SERVER`, `SQL_DB`, `SQL_USER`, `SQL_PASS`) integrado ao cache do PQTest
- Tema de ícones **M Lens Icons** com ícones para `.pq` e `.m`
- **M Lens Icons** definido como tema de ícones padrão quando não houver preferência explícita do usuário
