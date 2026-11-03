# Contato "Fora do funil" — Plano de implementação

> Executado na mesma sessão que o desenhou (sem handoff). Cada tarefa: teste primeiro, vê falhar, implementa, vê
> passar, commit. Não mesclar nem tocar a VPS sem OK do Carlos.

**Spec:** [`../specs/2026-10-29-contato-fora-do-funil-design.md`](../specs/2026-10-29-contato-fora-do-funil-design.md)

## Global Constraints

- Worktree `/home/user/elev-crm-fora`, branch `elev/fora-do-funil` (da main 1.23.0). Push `git push fork <branch>`; PR
  `gh pr create --repo Elevstudio-Dev/ElevCRM --base main`.
- Migration `supabase/migrations/20261030120000_0221_contato_fora_do_funil.sql` (idempotente), o MESMO SQL no apêndice
  do `supabase/baseline.sql` ANTES do bloco `VARREDURA anon`, linha no `MANIFEST.md`, `notify pgrst, 'reload schema'`,
  função nova: `revoke execute ... from public, anon` + `grant`. Relatórios (0220) são REDEFINIDOS com
  `create or replace` na 0221.
- Todo literal de `t()`/`traduzir()` novo precisa de entrada `es` em `lib/i18n/dicionario.ts` (grep antes: chave
  duplicada quebra o typecheck). Sem `rounded` puro, sem `console.log`, sem nome de provedor fora de `lib/channels/`.
- Auditoria: ações novas NO FIM de `lib/audit/actions.ts`; `resourceId` é UUID.
- Cópia para a área de transferência só por `lib/clipboard`.
- Ferramentas (Windows+WSL): rodar comandos por scripts `wsl.exe -- bash <script>`; editar por UNC
  `\\wsl.localhost\Ubuntu\home\user\elev-crm-fora\…`; `tsc` com `NODE_OPTIONS=--max-old-space-size=5120`.
- Portão: `pnpm gov:verify` + `pnpm test:shell` + `pnpm test:db` (árvore PARADA durante o test:db) + e2e local.
  Rodar também `barra-superior-nao-se-sobrepoe` e `navegacao.spec` se mexer na barra (lição do PR #19).

## Tarefas

1. **Schema (0221)** — tabela `tipos_fora_do_funil` (RLS), colunas em `contacts` e `crm_leads`, triggers de espelho,
   `create or replace` das 3 funções de relatório com `and not l.fora_do_funil`, tipos, varreduras
   (`rls-completude-varredura`), invariante `tests/invariants/contato-fora-do-funil.test.ts` (isolamento, espelho ao
   marcar/desmarcar, lead novo herda, relatório não conta, anon sem execute).
2. **Regra da IA** — `lib/ai/elegibilidade/gate.ts` (`fora_do_funil` vence tudo), as duas consultas, `before-send`
   (veto `contato_fora_do_funil` + `readStopFlags`), `comandoDaConversa` (motivo legível). Testes unitários.
3. **Nascimento recusado** — `garantirLeadDaConversa` (motivo `contato_fora_do_funil`), `POST /api/v1/leads` (409),
   webhook de formulário, importação de planilha. Testes + caso no invariante `nascimento-do-lead`.
4. **Filtros nas telas e rotinas** + **guarda** `leads-fora-do-funil-guarda.test.ts` com allowlist e motivos.
5. **API** — `PATCH /api/v1/contacts/fora-do-funil` (um ou vários; marcar/desmarcar; tipo; devolve contagem do que
   sai/volta; agent+; auditoria; atividade no negócio), `GET .../fora-do-funil/previa`, CRUD
   `/api/v1/tipos-fora-do-funil` (manager+), filtro `fora_do_funil` e `tipo` na listagem de contatos.
6. **Telas** — diálogo de marcar/desmarcar (ficha, cabeçalho da conversa, lote), selo na lista de contatos e no
   Inbox, filtro, tela de tipos em Configurações, registry de navegação.
7. **e2e** — jornada completa (marcar → IA não é acionada e nenhum lead nasce → negócio antigo some do quadro e do
   relatório → desmarcar → tudo volta), papéis, celular.
8. **Docs, portão, mutações, PR, CI.** Parar no PR verde.
