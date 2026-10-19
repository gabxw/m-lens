# M Lens — Power Query Tools

Edite o Power Query de um **Projeto do Power BI (PBIP)** no VS Code: verifique o seu M, veja o preview dos dados e aplique as queries de volta ao modelo com segurança.

O M Lens funciona em cima da extensão oficial [Power Query / M Language](https://marketplace.visualstudio.com/items?itemName=PowerQuery.vscode-powerquery), instalada junto, que cuida de IntelliSense, destaque de sintaxe e formatação.

A interface segue o idioma do VS Code: em português quando o VS Code está em português, em inglês nos demais casos.

## Primeiros passos

1. No Power BI Desktop, use **Arquivo > Salvar como > Projeto do Power BI (.pbip)**.
2. Abra a pasta do projeto no VS Code e clique no ícone do **M Lens** na barra de atividades.
3. Clique em **Extrair queries para editar**. Cada query vira um arquivo `.pq` em `mlens-queries/`.
4. Edite as queries. Ao terminar, clique em **Alterações para aplicar** para revisar o diff e depois em **Aplicar queries ao PBIP**.

Feche o projeto no Power BI Desktop antes de aplicar e abra de novo depois para ver as alterações.

## Recursos

### Barra lateral

A visão do M Lens mostra em que pé está o projeto e o que fazer em seguida: queries para extrair, edições esperando para serem aplicadas, possíveis segredos e se o preview de dados está configurado. Também lista todas as fontes de dados (agrupadas por conector; clique para ir até a linha) e quais queries dependem de quais.

### Aplicação segura no PBIP

- As queries são localizadas pelo nome, não pelo número da linha, então editar os `.tmdl` no meio do caminho não quebra nada.
- Só o código M das queries que você editou é substituído. Tudo o que o Power BI guarda em volta (`lineageTag`, `queryGroup`, annotations, quebras de linha) continua igual.
- **Revisar alterações do PBIP** abre o diff de cada `.tmdl`: o conteúdo atual ao lado do resultado depois de aplicar.
- Antes de gravar, o M Lens salva uma cópia de cada `.tmdl` alterado em `.mlens/backups/<data-hora>/`.
- Extrair de novo pergunta antes de sobrescrever `.pq` com edições ainda não aplicadas.

### Linter

Regras que o editor do Power Query não verifica:

| Regra | Padrão | O que encontra |
|---|---|---|
| `unused-step` | warning | Step declarado e nunca usado, com correção rápida para remover |
| `table-buffer` | info | `Table.Buffer`, `List.Buffer` e `Binary.Buffer`, que carregam os dados em memória e interrompem o query folding |
| `hardcoded-path` | warning | Caminhos de arquivo locais ou de rede (`C:\...`, `\\servidor\...`) fora de parâmetros |
| `generic-step-name` | hint | Nomes gerados pelo editor, em inglês ou português (`Custom1`, `Tipo Alterado1`), com correção rápida para renomear |
| `sensitive-literal` | warning | Texto que parece segredo: `Password=...`, `api_key=...`, Bearer tokens, formatos conhecidos de chave |
| `localhost-source` | warning | Fontes apontando para `localhost` ou `127.0.0.1` |
| `web-contents-options` | info | `Web.Contents` com query string fixa em vez das opções `RelativePath` e `Query` |
| `remove-columns-risk` | hint | `Table.RemoveColumns` quando `Table.SelectColumns` seria mais explícito |

Ajuste a severidade de cada regra nas configurações `mlens.lint.*` (`off`, `hint`, `info`, `warning`, `error`). **Verificar todas as queries** roda as regras em todos os `.pq` e `.m` do workspace.

### Preview de dados (Windows)

**Preview dos dados da query** (o botão de play no título do editor) executa a query atual com o `PQTest.exe` e mostra o resultado numa tabela que dá para filtrar, ordenar e redimensionar. Selecione uma linha para ler valores longos por inteiro.

O `PQTest.exe` vem com a extensão [Power Query SDK](https://marketplace.visualstudio.com/items?itemName=PowerQuery.vscode-powerquery-sdk). O M Lens encontra o executável sozinho, ou você pode configurar `mlens.preview.pqTestPath`.

**Credenciais:**

- **Arquivos e pastas locais** usam a sua conta do Windows automaticamente.
- **SQL Server:** escreva o servidor e o banco reais, por exemplo `Sql.Database("sql01", "Vendas")`. Na primeira vez, o M Lens pede um login e salva só para aquele servidor e banco. Um login nunca é enviado a outro servidor.
- **Fontes web:** escolha autenticação anônima ou Windows quando for perguntado.
- **APIs:** cadastre uma credencial em **Gerenciar credenciais do preview** e leia com `MLens_GetCredential("Nome")`. Essa função só existe no preview, então o M Lens se recusa a aplicar ao PBIP uma query que a use.

Os segredos ficam no cofre de segredos do VS Code. Só as credenciais que a query referencia entram no arquivo temporário do preview, apagado logo depois da execução.

### Ler queries de um PBIX

Clique com o botão direito num `.pbix` e escolha **Abrir queries de um PBIX (somente leitura)**. Arquivos salvos no formato novo não trazem as queries de forma legível; nesses casos o M Lens explica como converter para PBIP.

### Relatório do workspace

**Mostrar relatório do workspace** abre um relatório somente leitura com fontes de dados, locais de possíveis segredos, dependências entre queries e próximos passos sugeridos.

## Limitações conhecidas

- O preview de dados precisa de Windows e do Power Query SDK.
- Fontes com login organizacional (SharePoint Online, OAuth) precisam de credencial configurada pelo Power Query SDK.
- As dependências entre queries são identificadas pelo nome do arquivo, então o mapa é aproximado.
- O linter não modela identificadores sombreados em `let` aninhados.

## Privacidade

O M Lens não coleta telemetria. Ele só lê e grava arquivos no seu workspace e na pasta de armazenamento do M Lens.

## Licença

MIT
