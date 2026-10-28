# Relatórios de origem e QR codes rastreáveis — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma aba "Relatórios" (gestor+) que mostra de onde os leads vêm até a venda, e uma tela que cria QR codes
cuja leitura, conversa, lead e venda são medidos.

**Architecture:** O QR aponta para `/q/<código>` (rota pública do CRM) que conta a leitura e redireciona para
`wa.me` com a mensagem + `#código`. Na entrada da mensagem (`lib/channels/pos-entrada.ts`, comum aos dois canais) um
passo novo reconhece o `#código`, registra a conversa e dá ao lead novo a origem `qr_code`. O relatório agrega no
banco (três funções `security invoker`) e as telas leem por rotas `/api/v1/...` gestor+.

**Tech Stack:** Next.js 16 App Router · React 19 · Supabase Postgres (RLS) · react-query · recharts 3 · qrcode 1.5 ·
vitest (jsdom por padrão) · Playwright.

**Spec:** [`docs/superpowers/specs/2026-10-28-relatorios-e-qr-codes-design.md`](../specs/2026-10-28-relatorios-e-qr-codes-design.md)
— leia antes de começar; as decisões do dono estão na seção 2 e NÃO são renegociáveis.

## Global Constraints

- Worktree: `/home/user/elev-crm-relatorios`, branch `elev/relatorios-e-qr-codes` (já criada a partir da main
  `ccf9d1c4`, deps instaladas, `.env.local` e `.env.e2e` copiados). Antes de começar: `git fetch fork main && git merge fork/main`.
- Remotes: `origin` = upstream (NÃO usar), `fork` = nosso. Push: `git push fork <branch>`; PR:
  `gh pr create --repo Elevstudio-Dev/ElevCRM --base main`. CI só roda em PR contra `main`.
- Migration nova: `supabase/migrations/20261029120000_0220_relatorios_e_qr_codes.sql`; **o mesmo SQL** vai no
  apêndice do `supabase/baseline.sql` **ANTES** da linha `-- ---- VARREDURA anon: função nova nasce exposta em quem
  ATUALIZA (migration 0116) ----` (hoje ~linha 18616), com cabeçalho `-- ---- relatórios e QR codes (migration 0220) ----`;
  linha nova no fim da tabela de `supabase/migrations/MANIFEST.md`. O texto do apêndice tem de ser IGUAL ao da
  migration (há teste que compara ignorando comentários).
- Toda função nova em `public`: `revoke execute ... from public, anon;` + `grant execute ... to <quem precisa>;`.
- Alfabeto do código: `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (31 símbolos, sem 0/1/I/L/O), 6 caracteres.
- Textos de tela em português via `t("…")` (`hooks/i18n/useT`), e **cada literal novo de `t()` precisa de entrada
  `es` em `lib/i18n/dicionario.ts`** (guarda `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`). Chave duplicada no
  objeto quebra o typecheck — confira com `grep -n '^  "Texto":\|^  Texto:' lib/i18n/dicionario.ts` antes de inserir.
- Proibidos: `rounded` puro (use `rounded-md`, `rounded-[12px]`…), `console.log` (use `logger`), nome de provedor
  (WAHA, Meta, Zernio…) em comentário/código fora de `lib/channels/` (`pnpm lint:channels`), cor literal fora dos
  tokens.
- Rota pública conta com `checkRateLimit` de `@/lib/ai/dispatcher/rate-limit` (retorna `{ allowed, ... }`).
- Auditoria: ações novas entram NO FIM do array de `lib/audit/actions.ts`; o campo de id do recurso é `resourceId`.
- Ferramentas (máquina do Carlos, Windows + WSL): rode comandos do repo via PowerShell `wsl.exe -- bash <script.sh>`
  com scripts escritos em arquivo (PowerShell come `|` e `$()` dentro de `bash -c`); converta CRLF→LF antes de rodar.
  Edite arquivos pelo caminho UNC `\\wsl.localhost\Ubuntu\home\user\elev-crm-relatorios\...`. `tsc` precisa de
  `NODE_OPTIONS=--max-old-space-size=5120`. Rode o portão com os dev servers parados.
- Comandos de prova:
  - unit de arquivos: `pnpm exec vitest run <arquivos>`
  - invariante isolado: `PATH=$PWD/node_modules/.bin:$PATH bash scripts/test-db.sh tests/invariants/<arquivo>`
  - portão: `pnpm gov:verify` + `pnpm test:shell`
  - banco: `pnpm test:db` (obrigatório — a mudança é de schema e RLS)
- NUNCA mandar mensagem real de WhatsApp nem tocar a VPS. Mesclar, cortar release e atualizar a VPS **só com OK
  explícito do Carlos**.

---

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20261029120000_0220_relatorios_e_qr_codes.sql` (novo) | 3 tabelas, RLS, índices, 3 funções de relatório |
| `supabase/baseline.sql` (apêndice) · `supabase/migrations/MANIFEST.md` | o mesmo schema para o kit self-host |
| `lib/database.types.ts` | tipos das 3 tabelas e 3 funções |
| `lib/qr-codes/codigo.ts` (+ `.test.ts`) | gerar/normalizar/extrair o código; mensagem final |
| `lib/qr-codes/link-do-whatsapp.ts` (+ `.test.ts`) | dígitos do telefone, link `wa.me`, link público `/q/` |
| `lib/qr-codes/leitura.ts` (+ `.test.ts`) | robô/pré-visualização, dispositivo, `DISPOSITIVOS_DE_LEITURA` |
| `lib/qr-codes/reconhecer.ts` (+ `.test.ts`) | passo 1b da entrada: casar `#código`, gravar conversa, origem do lead, vincular lead |
| `lib/leads/nascimento-do-lead.ts` | `origem?` opcional com precedência QR > anúncio > whatsapp |
| `lib/channels/pos-entrada.ts` | chama o passo 1b entre opt-out e `abrirDemanda` |
| `app/q/[codigo]/route.ts` (novo) · `lib/auth/public-paths.ts` | rota pública: conta e redireciona |
| `lib/schemas/qr-codes.ts` · `app/api/v1/qr-codes/route.ts` · `app/api/v1/qr-codes/[id]/route.ts` | CRUD gestor+ |
| `lib/relatorios/origens.ts` (+ `.test.ts`) · `lib/schemas/relatorios.ts` | agrupar linhas do banco em grupos com rótulo; período |
| `app/api/v1/relatorios/origens/route.ts` · `app/api/v1/relatorios/qr-codes/route.ts` | leitura dos relatórios |
| `hooks/relatorios/useRelatorioDeOrigens.ts` · `hooks/qr-codes/useQrCodes.ts` | react-query |
| `app/app/relatorios/page.tsx` · `app/app/relatorios/_components/*` | tela de origens |
| `app/app/relatorios/qr-codes/page.tsx` · `app/app/relatorios/qr-codes/_components/*` | tela de QR codes |
| `lib/navigation/registry.ts` · `tests/unit/navegacao-registry.test.ts` | aba 6 gestor+, destino QR codes |
| `lib/kanban/prazo-e-origem.ts` · `components/kanban/KanbanCard.tsx` | "QR: <nome>" no card |
| `lib/audit/actions.ts` | `qr_code.created/updated/archived/restored` |
| `tests/invariants/qr-codes-rls.test.ts` (novo) · `tests/invariants/rls-completude-varredura.test.ts` · `tests/invariants/vocabulario-banco-x-typescript.test.ts` | provas de banco |
| `tests/e2e/relatorios-e-qr-codes.spec.ts` (novo) · `.github/workflows/e2e.yml` | jornada no navegador |
| `.changes/relatorios-e-qr-codes.md` · `docs/testing/user-journey-map.md` | changelog e mapa de jornadas |

---

### Task 1: Schema — tabelas, RLS e funções de relatório

**Files:**
- Create: `supabase/migrations/20261029120000_0220_relatorios_e_qr_codes.sql`
- Modify: `supabase/baseline.sql` (apêndice antes da VARREDURA anon), `supabase/migrations/MANIFEST.md`, `lib/database.types.ts`
- Test: `tests/invariants/qr-codes-rls.test.ts` (novo), `tests/invariants/rls-completude-varredura.test.ts`, `tests/invariants/vocabulario-banco-x-typescript.test.ts`

**Interfaces:**
- Produces (SQL): tabelas `qr_codes`, `qr_code_leituras`, `qr_code_conversas`; funções
  `fn_relatorio_de_origens(p_org uuid, p_de timestamptz, p_ate timestamptz)`,
  `fn_relatorio_de_origens_por_dia(p_org uuid, p_de timestamptz, p_ate timestamptz, p_fuso text)`,
  `fn_relatorio_de_qr_codes(p_org uuid, p_de timestamptz, p_ate timestamptz)`.

- [ ] **Step 1: Escrever o teste de invariante (vai falhar: as tabelas não existem)**

Crie `tests/invariants/qr-codes-rls.test.ts` copiando o molde de `tests/invariants/historico-de-captacao-rls.test.ts`
(funções `sql` e `countAs` idênticas, UUIDs próprios com prefixo `dddddddd-`). Conteúdo:

```ts
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * QR CODES E RELATÓRIOS: isolamento entre organizações E gate de papel (manager+).
 *
 * As três tabelas exigem `manager` para ler (o relatório é gestor+). Conectar como `postgres` não mediria
 * nada (rolbypassrls) — aqui é `set role authenticated` + `request.jwt.claims`, o caminho da produção.
 * As funções de relatório são `security invoker`: o mesmo gate tem de valer através delas.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const last = out.split("\n").pop();
  if (last === undefined || !/^-?\d+$/.test(last)) throw new Error(`saída inesperada do psql: ${out}`);
  return Number(last);
}

const ORG_A = "dddddddd-0000-4000-8000-00000000000a";
const ORG_B = "dddddddd-0000-4000-8000-00000000000b";
const MANAGER_A = "dddddddd-1111-4000-8000-00000000000a";
const AGENT_A = "dddddddd-1111-4000-8000-00000000000c";
const MANAGER_B = "dddddddd-1111-4000-8000-00000000000b";
const QR_A = "dddddddd-2222-4000-8000-00000000000a";
const QR_B = "dddddddd-2222-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'qr-mgr-a@invariant.test'),
      ('${AGENT_A}',   'qr-agent-a@invariant.test'),
      ('${MANAGER_B}', 'qr-mgr-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'qr-inv-a', 'QR Invariant A', 'QR A'),
      ('${ORG_B}', 'qr-inv-b', 'QR Invariant B', 'QR B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.qr_codes (id, organization_id, codigo, nome, mensagem) values
      ('${QR_A}', '${ORG_A}', 'AAAA22', 'Cartaz A', 'Olá A'),
      ('${QR_B}', '${ORG_B}', 'BBBB22', 'Cartaz B', 'Olá B')
      on conflict (id) do nothing;
    -- ids fixos + on conflict: rodar de novo na mesma base não pode virar 2 leituras.
    insert into public.qr_code_leituras (id, organization_id, qr_code_id, dispositivo) values
      ('dddddddd-3333-4000-8000-00000000000a', '${ORG_A}', '${QR_A}', 'celular'),
      ('dddddddd-3333-4000-8000-00000000000b', '${ORG_B}', '${QR_B}', 'celular')
      on conflict (id) do nothing;
  `);
});

describe("qr_codes e leituras: isolamento e papel", () => {
  it("manager A vê os da org A e NÃO vê os da org B", () => {
    expect(countAs(MANAGER_A, `select count(*) from public.qr_codes where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
    expect(countAs(MANAGER_A, `select count(*) from public.qr_codes where organization_id = '${ORG_B}';`)).toBe(0);
    expect(countAs(MANAGER_A, `select count(*) from public.qr_code_leituras where organization_id = '${ORG_B}';`)).toBe(0);
  });

  it("agent da PRÓPRIA org não lê (o relatório é gestor+)", () => {
    expect(countAs(AGENT_A, `select count(*) from public.qr_codes;`)).toBe(0);
    expect(countAs(AGENT_A, `select count(*) from public.qr_code_leituras;`)).toBe(0);
  });

  it("manager A não cria QR na org B", () => {
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
        insert into public.qr_codes (organization_id, codigo, nome, mensagem) values ('${ORG_B}', 'CCCC22', 'x', 'y');
      `),
    ).toThrow();
  });

  it("agent não cria QR nem na própria org", () => {
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${AGENT_A}"}', false);
        insert into public.qr_codes (organization_id, codigo, nome, mensagem) values ('${ORG_A}', 'DDDD22', 'x', 'y');
      `),
    ).toThrow();
  });

  it("código fora do alfabeto é recusado pelo banco", () => {
    expect(() =>
      sql(`insert into public.qr_codes (organization_id, codigo, nome, mensagem) values ('${ORG_A}', 'ABC10O', 'x', 'y');`),
    ).toThrow();
  });

  it("código é único na INSTALAÇÃO (a rota pública não sabe a org)", () => {
    expect(() =>
      sql(`insert into public.qr_codes (organization_id, codigo, nome, mensagem) values ('${ORG_B}', 'AAAA22', 'x', 'y');`),
    ).toThrow();
  });
});

describe("funções de relatório", () => {
  it("a função do QR, chamada por manager B pedindo a org A, não devolve linha nenhuma", () => {
    expect(
      countAs(
        MANAGER_B,
        `select count(*) from public.fn_relatorio_de_qr_codes('${ORG_A}', now() - interval '1 day', now() + interval '1 day');`,
      ),
    ).toBe(0);
  });

  it("manager A vê a leitura do próprio QR pela função", () => {
    expect(
      countAs(
        MANAGER_A,
        `select coalesce(sum(leituras),0) from public.fn_relatorio_de_qr_codes('${ORG_A}', now() - interval '1 day', now() + interval '1 day');`,
      ),
    ).toBe(1);
  });

  it("anon não executa nenhuma das três funções", () => {
    for (const fn of [
      "fn_relatorio_de_origens(uuid,timestamptz,timestamptz)",
      "fn_relatorio_de_origens_por_dia(uuid,timestamptz,timestamptz,text)",
      "fn_relatorio_de_qr_codes(uuid,timestamptz,timestamptz)",
    ]) {
      expect(sql(`select has_function_privilege('anon', 'public.${fn}', 'execute');`)).toBe("f");
    }
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `PATH=$PWD/node_modules/.bin:$PATH bash scripts/test-db.sh tests/invariants/qr-codes-rls.test.ts`
Expected: FAIL — `relation "public.qr_codes" does not exist`.

- [ ] **Step 3: Escrever a migration**

`supabase/migrations/20261029120000_0220_relatorios_e_qr_codes.sql`:

```sql
-- ============================================================================
-- 0220 — RELATÓRIOS DE ORIGEM E QR CODES RASTREÁVEIS.
--
-- O produto já grava de onde parte dos leads vem (anúncio do Meta no contato, utm_* do formulário), mas não
-- havia tela que agregasse, e mídia offline (cartaz, panfleto) não deixava rastro nenhum. Esta migration cria:
--
--  * `qr_codes`            — o QR que o gestor imprime. Código de 6 caracteres sem ambíguos, ÚNICO NA INSTALAÇÃO
--                            (a rota pública `/q/<código>` não sabe a organização). Arquivar em vez de apagar: o
--                            papel impresso continua existindo, e o histórico dele também.
--  * `qr_code_leituras`    — uma linha por leitura contada. SEM IP e SEM user-agent: a pergunta é "quantos leram",
--                            não "quem leu" (minimização LGPD).
--  * `qr_code_conversas`   — a conversa que chegou com `#código`. Única por (QR, conversa): mandar o código de
--                            novo não infla o número.
--  * 3 funções de relatório `security invoker` — agregam no banco porque o PostgREST corta em 1.000 linhas, e
--    somar em JS mentiria em silêncio na primeira organização com 1.001 leads no período.
--
-- RLS: as três tabelas exigem manager+ para ler (molde da 0174). Só o service role escreve leituras e conversas.
-- ============================================================================

create table if not exists public.qr_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  codigo text not null,
  nome text not null,
  mensagem text not null,
  channel_session_id uuid references public.channel_sessions(id) on delete set null,
  arquivado_em timestamptz,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qr_codes_codigo_formato check (codigo ~ '^[2-9A-HJKMNP-Z]{6}$'),
  constraint qr_codes_nome_tamanho check (char_length(btrim(nome)) between 1 and 80),
  constraint qr_codes_mensagem_tamanho check (char_length(btrim(mensagem)) between 1 and 300)
);

create unique index if not exists qr_codes_codigo_uidx on public.qr_codes (codigo);
create index if not exists qr_codes_org_idx on public.qr_codes (organization_id, created_at desc);

drop trigger if exists trg_qr_codes_updated_at on public.qr_codes;
create trigger trg_qr_codes_updated_at before update on public.qr_codes
  for each row execute function public.fn_set_updated_at();

create table if not exists public.qr_code_leituras (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  qr_code_id uuid not null references public.qr_codes(id) on delete cascade,
  lida_em timestamptz not null default now(),
  dispositivo text not null default 'outro'
    check (dispositivo in ('celular', 'computador', 'outro'))
);

create index if not exists qr_code_leituras_qr_idx on public.qr_code_leituras (qr_code_id, lida_em);
create index if not exists qr_code_leituras_org_idx on public.qr_code_leituras (organization_id, lida_em);

create table if not exists public.qr_code_conversas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  qr_code_id uuid not null references public.qr_codes(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  criada_em timestamptz not null default now(),
  constraint qr_code_conversas_uma_por_conversa unique (qr_code_id, conversation_id)
);

create index if not exists qr_code_conversas_org_idx on public.qr_code_conversas (organization_id, criada_em);

-- "Quantos leads este QR trouxe" sem varrer `crm_leads` inteira.
create index if not exists crm_leads_qr_code_idx on public.crm_leads ((source_metadata->>'qr_code_id'))
  where source = 'qr_code';

alter table public.qr_codes enable row level security;
alter table public.qr_code_leituras enable row level security;
alter table public.qr_code_conversas enable row level security;

drop policy if exists "qr_codes_manager_read" on public.qr_codes;
create policy "qr_codes_manager_read" on public.qr_codes
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists "qr_codes_manager_insert" on public.qr_codes;
create policy "qr_codes_manager_insert" on public.qr_codes
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'manager')
  );

drop policy if exists "qr_codes_manager_update" on public.qr_codes;
create policy "qr_codes_manager_update" on public.qr_codes
  for update using (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'manager')
  ) with check (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'manager')
  );

drop policy if exists "qr_code_leituras_manager_read" on public.qr_code_leituras;
create policy "qr_code_leituras_manager_read" on public.qr_code_leituras
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists "qr_code_conversas_manager_read" on public.qr_code_conversas;
create policy "qr_code_conversas_manager_read" on public.qr_code_conversas
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- Leads por (origem, detalhe) no período, pela data de CRIAÇÃO do lead. `detalhe` é o que distingue dentro da
-- origem: o QR, o anúncio, a campanha do formulário (ou a fonte, quando o formulário não mandou utm).
create or replace function public.fn_relatorio_de_origens(p_org uuid, p_de timestamptz, p_ate timestamptz)
returns table (
  source text,
  detalhe text,
  leads bigint,
  abertos bigint,
  ganhos bigint,
  perdidos bigint,
  valor_ganho_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(nullif(l.source, ''), 'desconhecida') as source,
    case
      when l.source = 'qr_code' then l.source_metadata->>'qr_code_id'
      when l.source in ('meta_ads', 'google_ads') then
        coalesce(nullif(l.source_metadata->>'ad_title', ''), nullif(l.source_metadata->>'ad_source_id', ''))
      when l.source = 'webhook' then
        coalesce(
          nullif(l.source_metadata->>'utm_campaign', ''),
          nullif(l.source_metadata->>'utm_source', ''),
          'fonte:' || nullif(l.source_metadata->>'webhook_source_id', '')
        )
      else null
    end as detalhe,
    count(*) as leads,
    count(*) filter (where l.status = 'open') as abertos,
    count(*) filter (where l.status = 'won') as ganhos,
    count(*) filter (where l.status = 'lost') as perdidos,
    coalesce(sum(l.value_cents) filter (where l.status = 'won' and coalesce(l.currency, 'BRL') = 'BRL'), 0)::bigint
      as valor_ganho_cents
  from public.crm_leads l
  where l.organization_id = p_org
    and l.created_at >= p_de
    and l.created_at < p_ate
    and l.status in ('open', 'won', 'lost')
  group by 1, 2
$$;

create or replace function public.fn_relatorio_de_origens_por_dia(
  p_org uuid, p_de timestamptz, p_ate timestamptz, p_fuso text default 'America/Sao_Paulo'
)
returns table (dia date, source text, leads bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    (l.created_at at time zone p_fuso)::date as dia,
    coalesce(nullif(l.source, ''), 'desconhecida') as source,
    count(*) as leads
  from public.crm_leads l
  where l.organization_id = p_org
    and l.created_at >= p_de
    and l.created_at < p_ate
    and l.status in ('open', 'won', 'lost')
  group by 1, 2
  order by 1, 2
$$;

-- Funil de cada QR da org no período: leituras → conversas → leads → ganhos (e R$ ganho). Um QR sem nada no
-- período aparece com zeros — o gestor precisa ver o QR que NÃO funciona.
create or replace function public.fn_relatorio_de_qr_codes(p_org uuid, p_de timestamptz, p_ate timestamptz)
returns table (
  qr_code_id uuid,
  leituras bigint,
  conversas bigint,
  leads bigint,
  ganhos bigint,
  valor_ganho_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    q.id as qr_code_id,
    (select count(*) from public.qr_code_leituras r
      where r.qr_code_id = q.id and r.lida_em >= p_de and r.lida_em < p_ate) as leituras,
    (select count(*) from public.qr_code_conversas c
      where c.qr_code_id = q.id and c.criada_em >= p_de and c.criada_em < p_ate) as conversas,
    (select count(*) from public.crm_leads l
      where l.organization_id = p_org and l.source = 'qr_code'
        and l.source_metadata->>'qr_code_id' = q.id::text
        and l.created_at >= p_de and l.created_at < p_ate) as leads,
    (select count(*) from public.crm_leads l
      where l.organization_id = p_org and l.source = 'qr_code'
        and l.source_metadata->>'qr_code_id' = q.id::text
        and l.created_at >= p_de and l.created_at < p_ate and l.status = 'won') as ganhos,
    (select coalesce(sum(l.value_cents), 0)::bigint from public.crm_leads l
      where l.organization_id = p_org and l.source = 'qr_code'
        and l.source_metadata->>'qr_code_id' = q.id::text
        and l.created_at >= p_de and l.created_at < p_ate and l.status = 'won'
        and coalesce(l.currency, 'BRL') = 'BRL') as valor_ganho_cents
  from public.qr_codes q
  where q.organization_id = p_org
$$;

revoke execute on function public.fn_relatorio_de_origens(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.fn_relatorio_de_origens(uuid, timestamptz, timestamptz) to authenticated, service_role;
revoke execute on function public.fn_relatorio_de_origens_por_dia(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.fn_relatorio_de_origens_por_dia(uuid, timestamptz, timestamptz, text) to authenticated, service_role;
revoke execute on function public.fn_relatorio_de_qr_codes(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.fn_relatorio_de_qr_codes(uuid, timestamptz, timestamptz) to authenticated, service_role;
```

- [ ] **Step 4: Apêndice no baseline e MANIFEST**

Cole o MESMO SQL (sem o cabeçalho de comentário longo, mas com o bloco `-- ---- relatórios e QR codes (migration
0220) ----` e comentários curtos) no `supabase/baseline.sql` imediatamente ANTES de
`-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----`. Confira:
`grep -n 'migration 0220\|VARREDURA anon: função nova' supabase/baseline.sql` — a 0220 tem de vir antes.

No fim da tabela de `supabase/migrations/MANIFEST.md`:

```
| `20261029120000` | `0220_relatorios_e_qr_codes` | **Relatórios de origem e QR codes rastreáveis.** Pedido do dono: medir de onde os leads vêm até a venda e medir mídia offline. Cria `qr_codes` (código de 6 caracteres sem ambíguos, único na instalação; arquivar em vez de apagar), `qr_code_leituras` (sem IP nem user-agent — minimização LGPD) e `qr_code_conversas` (única por QR+conversa), todas com SELECT manager+; e as funções `security invoker` `fn_relatorio_de_origens`, `fn_relatorio_de_origens_por_dia` e `fn_relatorio_de_qr_codes` (agregam no banco: o PostgREST corta em 1.000 linhas). Revogadas de public/anon. Índice parcial `crm_leads ((source_metadata->>'qr_code_id')) where source='qr_code'`. |
```

- [ ] **Step 5: Registrar nas varreduras**

Em `tests/invariants/rls-completude-varredura.test.ts`, no array `PROVA_PROPRIA`, acrescente três entradas:

```ts
  {
    tabela: "qr_codes",
    razao:
      "tests/invariants/qr-codes-rls.test.ts prova isolamento cross-tenant E o gate de papel (agent não lê " +
      "nem cria). Fora de TABLES pelo mesmo motivo de webhook_lead_captures: a policy exige manager.",
  },
  {
    tabela: "qr_code_leituras",
    razao: "tests/invariants/qr-codes-rls.test.ts — mesmo caso da linha acima.",
  },
  {
    tabela: "qr_code_conversas",
    razao:
      "tests/invariants/qr-codes-rls.test.ts — mesma policy manager+ das outras duas; só o service role escreve.",
  },
```

Em `tests/invariants/vocabulario-banco-x-typescript.test.ts`, no array de colunas com CHECK (onde está
`webhook_lead_captures.outcome`), acrescente:

```ts
  {
    tabela: "qr_code_leituras",
    coluna: "dispositivo",
    // lib/qr-codes/leitura.ts → DISPOSITIVOS_DE_LEITURA. A rota pública grava; um valor novo só no TypeScript
    // viraria 23514 dentro dela e a leitura simplesmente não seria contada.
    arquivo: "lib/qr-codes/leitura.ts",
    simbolo: "DISPOSITIVOS_DE_LEITURA",
  },
```

(O `lib/qr-codes/leitura.ts` nasce na Task 2; este invariante só passa depois dela — rode `pnpm test:db` ao fim
da Task 2.)

- [ ] **Step 6: Tipos**

Em `lib/database.types.ts`, dentro de `public.Tables`, acrescente `qr_codes`, `qr_code_leituras` e
`qr_code_conversas` no mesmo formato de `webhook_lead_captures` (Row com todas as colunas; Insert com as de default
opcionais; Update tudo opcional; `Relationships: []`). Dentro de `public.Functions`, acrescente:

```ts
      fn_relatorio_de_origens: {
        Args: { p_org: string; p_de: string; p_ate: string }
        Returns: {
          source: string
          detalhe: string | null
          leads: number
          abertos: number
          ganhos: number
          perdidos: number
          valor_ganho_cents: number
        }[]
      }
      fn_relatorio_de_origens_por_dia: {
        Args: { p_org: string; p_de: string; p_ate: string; p_fuso?: string }
        Returns: { dia: string; source: string; leads: number }[]
      }
      fn_relatorio_de_qr_codes: {
        Args: { p_org: string; p_de: string; p_ate: string }
        Returns: {
          qr_code_id: string
          leituras: number
          conversas: number
          leads: number
          ganhos: number
          valor_ganho_cents: number
        }[]
      }
```

- [ ] **Step 7: Rodar o invariante e ver passar**

Run: `PATH=$PWD/node_modules/.bin:$PATH bash scripts/test-db.sh tests/invariants/qr-codes-rls.test.ts`
Expected: PASS (10 casos). Depois confira que nenhum teste de baseline quebrou:
`pnpm exec vitest run tests/unit/baseline` (os guardas de apêndice/varredura).

- [ ] **Step 8: Commit**

```bash
git add supabase tests/invariants lib/database.types.ts
git commit -m "feat(banco): QR codes rastreáveis e funções de relatório de origem (0220)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Regras puras do QR (código, link, leitura)

**Files:**
- Create: `lib/qr-codes/codigo.ts`, `lib/qr-codes/codigo.test.ts`, `lib/qr-codes/link-do-whatsapp.ts`,
  `lib/qr-codes/link-do-whatsapp.test.ts`, `lib/qr-codes/leitura.ts`, `lib/qr-codes/leitura.test.ts`

**Interfaces:**
- Produces: `ALFABETO_DO_CODIGO`, `TAMANHO_DO_CODIGO`, `gerarCodigo(aleatorio?) → string`,
  `normalizarCodigo(bruto) → string | null`, `extrairCodigoDaMensagem(texto) → string | null`,
  `mensagemComCodigo(mensagem, codigo) → string`; `digitosDoTelefone(tel) → string | null`,
  `linkDoWhatsApp(tel, mensagem, codigo) → string | null`, `linkPublicoDoQr(origem, codigo) → string`;
  `DISPOSITIVOS_DE_LEITURA`, `type Dispositivo`, `ehLeituraDeRobo(ua) → boolean`, `dispositivoDoAgente(ua) → Dispositivo`.

- [ ] **Step 1: Testes (falham: módulos não existem)**

`lib/qr-codes/codigo.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ALFABETO_DO_CODIGO,
  extrairCodigoDaMensagem,
  gerarCodigo,
  mensagemComCodigo,
  normalizarCodigo,
} from "./codigo";

describe("gerarCodigo", () => {
  it("6 caracteres, só do alfabeto sem ambíguos", () => {
    for (let i = 0; i < 200; i++) {
      const c = gerarCodigo();
      expect(c).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    }
  });

  it("descarta bytes que enviesariam o sorteio (>= 248) em vez de usar o resto", () => {
    // 255 seria 255 % 31 = 7 — aceitar daria mais peso aos 8 primeiros símbolos.
    let chamada = 0;
    const fonte = () => {
      chamada++;
      return chamada === 1 ? new Uint8Array([255, 250, 248, 0, 1, 2, 3, 4, 5]) : new Uint8Array(16);
    };
    expect(gerarCodigo(fonte)).toBe(ALFABETO_DO_CODIGO.slice(0, 6));
  });
});

describe("normalizarCodigo", () => {
  it("aceita minúsculas e espaços em volta", () => {
    expect(normalizarCodigo(" r7k2qh ")).toBe("R7K2QH");
  });
  it("recusa ambíguos, tamanho errado e vazio", () => {
    expect(normalizarCodigo("R7K2Q0")).toBeNull(); // 0
    expect(normalizarCodigo("R7K2QI")).toBeNull(); // I
    expect(normalizarCodigo("R7K2Q")).toBeNull();
    expect(normalizarCodigo("R7K2QHH")).toBeNull();
    expect(normalizarCodigo(null)).toBeNull();
  });
});

describe("extrairCodigoDaMensagem", () => {
  it("acha o código no fim da mensagem pronta", () => {
    expect(extrairCodigoDaMensagem("Olá! Vi o cartaz da recepção #R7K2QH")).toBe("R7K2QH");
  });
  it("acha no meio e com pontuação depois", () => {
    expect(extrairCodigoDaMensagem("oi #r7k2qh, tudo bem?")).toBe("R7K2QH");
  });
  it("não acha sem o #, nem dentro de palavra, nem com 7 caracteres", () => {
    expect(extrairCodigoDaMensagem("R7K2QH")).toBeNull();
    expect(extrairCodigoDaMensagem("abc#R7K2QH")).toBeNull();
    expect(extrairCodigoDaMensagem("#R7K2QHX")).toBeNull();
  });
  it("texto vazio ou nulo não é código", () => {
    expect(extrairCodigoDaMensagem(null)).toBeNull();
    expect(extrairCodigoDaMensagem("")).toBeNull();
  });
});

describe("mensagemComCodigo", () => {
  it("frase + espaço + #código, sem espaço duplicado", () => {
    expect(mensagemComCodigo("Olá!  ", "R7K2QH")).toBe("Olá! #R7K2QH");
  });
});
```

`lib/qr-codes/link-do-whatsapp.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { digitosDoTelefone, linkDoWhatsApp, linkPublicoDoQr } from "./link-do-whatsapp";

describe("digitosDoTelefone", () => {
  it("tira tudo que não é dígito", () => {
    expect(digitosDoTelefone("+55 (11) 98765-4321")).toBe("5511987654321");
  });
  it("curto ou longo demais não é telefone", () => {
    expect(digitosDoTelefone("12345")).toBeNull();
    expect(digitosDoTelefone("1234567890123456")).toBeNull();
    expect(digitosDoTelefone(null)).toBeNull();
  });
});

describe("linkDoWhatsApp", () => {
  it("wa.me com os dígitos e a mensagem + código codificados", () => {
    expect(linkDoWhatsApp("+5511987654321", "Olá! Vi o cartaz", "R7K2QH")).toBe(
      "https://wa.me/5511987654321?text=Ol%C3%A1!%20Vi%20o%20cartaz%20%23R7K2QH",
    );
  });
  it("sem telefone válido não há link", () => {
    expect(linkDoWhatsApp(null, "x", "R7K2QH")).toBeNull();
  });
});

describe("linkPublicoDoQr", () => {
  it("origem sem barra no fim + /q/código", () => {
    expect(linkPublicoDoQr("https://crm.exemplo.com.br/", "R7K2QH")).toBe("https://crm.exemplo.com.br/q/R7K2QH");
  });
});
```

`lib/qr-codes/leitura.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { dispositivoDoAgente, ehLeituraDeRobo } from "./leitura";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

describe("ehLeituraDeRobo", () => {
  it("pré-visualização de link e robôs não contam", () => {
    for (const ua of [
      "facebookexternalhit/1.1",
      "WhatsApp/2.23.20.0 A",
      "Googlebot/2.1",
      "Slackbot-LinkExpanding 1.0",
      "TelegramBot (like TwitterBot)",
      "curl/8.4.0",
    ]) {
      expect(ehLeituraDeRobo(ua), ua).toBe(true);
    }
  });
  it("sem user-agent não conta (não é a câmera de um celular)", () => {
    expect(ehLeituraDeRobo(null)).toBe(true);
    expect(ehLeituraDeRobo("  ")).toBe(true);
  });
  it("navegador de celular e de computador contam", () => {
    expect(ehLeituraDeRobo(IPHONE)).toBe(false);
    expect(ehLeituraDeRobo(ANDROID)).toBe(false);
    expect(ehLeituraDeRobo(WINDOWS)).toBe(false);
  });
});

describe("dispositivoDoAgente", () => {
  it("Android (que diz Linux) é celular, não computador", () => {
    expect(dispositivoDoAgente(ANDROID)).toBe("celular");
  });
  it("iPhone é celular, Windows é computador, vazio é outro", () => {
    expect(dispositivoDoAgente(IPHONE)).toBe("celular");
    expect(dispositivoDoAgente(WINDOWS)).toBe("computador");
    expect(dispositivoDoAgente(null)).toBe("outro");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/qr-codes` → FAIL (módulos inexistentes).

- [ ] **Step 3: Implementar**

`lib/qr-codes/codigo.ts`:

```ts
/**
 * O CÓDIGO DO QR — o que liga a mensagem que chega ao QR que foi lido.
 *
 * Seis caracteres de um alfabeto SEM ambíguos (sem 0/O, 1/I/L): a pessoa às vezes redigita o código, e o
 * gestor às vezes o lê em voz alta. 31⁶ ≈ 887 milhões de combinações — colisão é tratada no INSERT (unique),
 * não aqui.
 *
 * Tudo puro: o sorteio recebe a fonte de bytes por argumento, e o teste não depende de sorte.
 */
export const ALFABETO_DO_CODIGO = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const TAMANHO_DO_CODIGO = 6;

const RE_CODIGO = /^[2-9A-HJKMNP-Z]{6}$/;
/** `#` + 6 do alfabeto, sem letra/dígito colado antes nem depois. Case-insensitive: o cliente pode redigitar. */
const RE_NA_MENSAGEM = /(?:^|[^\p{L}\p{N}_])#([2-9a-hjkmnp-z]{6})(?![\p{L}\p{N}_])/iu;

/** Maior múltiplo de 31 que cabe num byte: bytes acima dele enviesariam o resto da divisão. */
const LIMITE_SEM_VIES = Math.floor(256 / ALFABETO_DO_CODIGO.length) * ALFABETO_DO_CODIGO.length;

export function gerarCodigo(
  aleatorio: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  let out = "";
  while (out.length < TAMANHO_DO_CODIGO) {
    for (const byte of aleatorio(16)) {
      if (byte >= LIMITE_SEM_VIES) continue;
      out += ALFABETO_DO_CODIGO[byte % ALFABETO_DO_CODIGO.length];
      if (out.length === TAMANHO_DO_CODIGO) break;
    }
  }
  return out;
}

export function normalizarCodigo(bruto: string | null | undefined): string | null {
  const c = (bruto ?? "").trim().toUpperCase();
  return RE_CODIGO.test(c) ? c : null;
}

export function extrairCodigoDaMensagem(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const m = RE_NA_MENSAGEM.exec(texto);
  return m ? normalizarCodigo(m[1]) : null;
}

/** A mensagem que o cliente envia: a frase do gestor + ` #CÓDIGO`. */
export function mensagemComCodigo(mensagem: string, codigo: string): string {
  return `${mensagem.trim()} #${codigo}`;
}
```

`lib/qr-codes/link-do-whatsapp.ts`:

```ts
import { mensagemComCodigo } from "./codigo";

/** Só os dígitos, e só se parecer telefone internacional (10 a 15 dígitos — E.164). */
export function digitosDoTelefone(telefone: string | null | undefined): string | null {
  const d = (telefone ?? "").replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** O link que abre o WhatsApp do cliente com a mensagem pronta. `null` sem telefone válido. */
export function linkDoWhatsApp(telefone: string | null | undefined, mensagem: string, codigo: string): string | null {
  const digitos = digitosDoTelefone(telefone);
  if (!digitos) return null;
  return `https://wa.me/${digitos}?text=${encodeURIComponent(mensagemComCodigo(mensagem, codigo))}`;
}

/** O endereço que vai DENTRO do QR: a rota do próprio CRM que conta a leitura. */
export function linkPublicoDoQr(origem: string, codigo: string): string {
  return `${origem.replace(/\/+$/, "")}/q/${codigo}`;
}
```

`lib/qr-codes/leitura.ts`:

```ts
/**
 * QUEM CONTA COMO LEITURA.
 *
 * O link do QR circula: colado num grupo, ele é aberto pelo robô de pré-visualização do próprio app de
 * mensagens antes de qualquer pessoa. Contar isso inflaria o funil. Sem user-agent também não conta — a câmera
 * de um celular abre um navegador, e navegador manda user-agent.
 *
 * Nada aqui é gravado: o user-agent só decide SE conta e de que tipo de aparelho veio.
 */
export const DISPOSITIVOS_DE_LEITURA = ["celular", "computador", "outro"] as const;
export type Dispositivo = (typeof DISPOSITIVOS_DE_LEITURA)[number];

const RE_ROBO =
  /bot\b|bot\/|crawler|spider|preview|facebookexternalhit|whatsapp\/|slackbot|telegrambot|discordbot|curl\/|wget\//i;

export function ehLeituraDeRobo(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  if (ua === "") return true;
  return RE_ROBO.test(ua);
}

export function dispositivoDoAgente(userAgent: string | null | undefined): Dispositivo {
  const ua = userAgent ?? "";
  if (ua.trim() === "") return "outro";
  // Celular ANTES de computador: o Android se declara "Linux".
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return "celular";
  if (/Windows|Macintosh|X11|Linux|CrOS/i.test(ua)) return "computador";
  return "outro";
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec vitest run lib/qr-codes` → PASS. Depois `pnpm test:db` (o invariante de vocabulário da Task 1
passa a ter o símbolo).

- [ ] **Step 5: Commit**

```bash
git add lib/qr-codes
git commit -m "feat(qr): regras puras do código, do link do WhatsApp e da leitura

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: A rota pública `/q/[codigo]`

**Files:**
- Create: `app/q/[codigo]/route.ts`, `app/q/[codigo]/route.test.ts`
- Modify: `lib/auth/public-paths.ts` (+ teste de rotas públicas, se existir: `grep -rln "PUBLIC_PATHS" tests/unit`)

**Interfaces:**
- Consumes: `normalizarCodigo`, `linkDoWhatsApp` (Task 2), `ehLeituraDeRobo`, `dispositivoDoAgente` (Task 2),
  `checkRateLimit` (`@/lib/ai/dispatcher/rate-limit`), `ipDoCliente` (`@/lib/http/ip-do-cliente`),
  `createAdminClient` (`@/lib/supabase/admin`).
- Produces: `GET /q/<código>` → 302 para `wa.me` | página HTML 404/410/503.

- [ ] **Step 1: Teste (falha: a rota não existe)**

`app/q/[codigo]/route.test.ts` — use `// @vitest-environment node` no topo (Response real). Mocke
`@/lib/supabase/admin` com um admin falso que devolve um QR por código e grava o insert de leitura numa lista;
mocke `@/lib/ai/dispatcher/rate-limit` (`checkRateLimit` → `{ allowed: true }` por padrão). Casos:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const leituras: Array<Record<string, unknown>> = [];
let qr: Record<string, unknown> | null = null;
let canal: Record<string, unknown> | null = null;
let permitido = true;

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: permitido })),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(tabela: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: tabela === "qr_codes" ? qr : canal, error: null }),
        insert: async (linha: Record<string, unknown>) => {
          leituras.push(linha);
          return { error: null };
        },
      };
      return builder;
    },
  }),
}));

import { GET } from "./route";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1";
const chamar = (codigo: string, ua: string | null = IPHONE) =>
  GET(new Request(`http://localhost/q/${codigo}`, { headers: ua ? { "user-agent": ua } : {} }) as never, {
    params: Promise.resolve({ codigo }),
  });

beforeEach(() => {
  leituras.length = 0;
  permitido = true;
  qr = {
    id: "qr-1",
    organization_id: "org-1",
    codigo: "R7K2QH",
    mensagem: "Olá! Vi o cartaz",
    arquivado_em: null,
    channel_session_id: "canal-1",
  };
  canal = { phone_number: "+5511987654321" };
});

describe("GET /q/[codigo]", () => {
  it("conta a leitura e redireciona para o WhatsApp com a mensagem + código", async () => {
    const r = await chamar("r7k2qh");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      "https://wa.me/5511987654321?text=Ol%C3%A1!%20Vi%20o%20cartaz%20%23R7K2QH",
    );
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(leituras).toEqual([{ organization_id: "org-1", qr_code_id: "qr-1", dispositivo: "celular" }]);
  });

  it("robô de pré-visualização é redirecionado mas NÃO conta", async () => {
    const r = await chamar("R7K2QH", "WhatsApp/2.23.20.0 A");
    expect(r.status).toBe(302);
    expect(leituras).toHaveLength(0);
  });

  it("acima do limite redireciona mas não conta — o limitador protege o número, não bloqueia a pessoa", async () => {
    permitido = false;
    const r = await chamar("R7K2QH");
    expect(r.status).toBe(302);
    expect(leituras).toHaveLength(0);
  });

  it("código malformado e QR inexistente: página 404, sem contar", async () => {
    expect((await chamar("ABC")).status).toBe(404);
    qr = null;
    expect((await chamar("R7K2QH")).status).toBe(404);
    expect(leituras).toHaveLength(0);
  });

  it("QR arquivado: 410 e não conta", async () => {
    qr = { ...qr, arquivado_em: "2026-10-01T00:00:00Z" };
    const r = await chamar("R7K2QH");
    expect(r.status).toBe(410);
    expect(await r.text()).toContain("não está mais ativo");
    expect(leituras).toHaveLength(0);
  });

  it("sem número de WhatsApp resolvível: 503 e não conta", async () => {
    canal = null;
    const r = await chamar("R7K2QH");
    expect(r.status).toBe(503);
    expect(leituras).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm exec vitest run "app/q"` → FAIL.

- [ ] **Step 3: Implementar a rota**

`app/q/[codigo]/route.ts`:

```ts
/**
 * GET /q/<código> — a porta de entrada do QR impresso.
 *
 * Conta a leitura e manda a pessoa para o WhatsApp com a mensagem pronta (+ `#código`, que é o que liga a
 * conversa ao QR quando ela chega). Pública de propósito (`lib/auth/public-paths.ts`) e fora de `/api`: o
 * endereço curto deixa o QR menos denso, e ele precisa ser lido impresso pequeno.
 *
 * O que NÃO bloqueia a pessoa: robô, limite e erro de gravação só deixam de CONTAR — o redirecionamento sai
 * igual. Quem perde é o número do relatório, nunca o cliente que queria falar com a empresa.
 *
 * Nada pessoal é gravado (sem IP, sem user-agent): o IP só alimenta o limitador em memória/Redis.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { normalizarCodigo } from "@/lib/qr-codes/codigo";
import { dispositivoDoAgente, ehLeituraDeRobo } from "@/lib/qr-codes/leitura";
import { linkDoWhatsApp } from "@/lib/qr-codes/link-do-whatsapp";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Leituras contadas por QR e por IP, por minuto. Acima disso a pessoa segue, a contagem não. */
const LEITURAS_POR_MINUTO = 10;

const SEM_CACHE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/** Página mínima e SEM marca (quem lê o QR pode nem saber qual CRM está por trás — e não precisa). */
function pagina(status: number, titulo: string, texto: string): Response {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${titulo}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f6f6f7;color:#1f1f23}main{max-width:22rem;padding:2rem 1.5rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#55555f;line-height:1.5}@media (prefers-color-scheme:dark){body{background:#141417;color:#ececf1}p{color:#a5a5b0}}</style></head><body><main><h1>${titulo}</h1><p>${texto}</p></main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SEM_CACHE } });
}

interface QrDaRota {
  id: string;
  organization_id: string;
  codigo: string;
  mensagem: string;
  arquivado_em: string | null;
  channel_session_id: string | null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ codigo: string }> }): Promise<Response> {
  const { codigo: bruto } = await ctx.params;
  const codigo = normalizarCodigo(bruto);
  const inativo = () =>
    pagina(404, "QR code não encontrado", "Este QR code não existe. Confira se o código foi digitado certo.");
  if (!codigo) return inativo();

  const admin = createAdminClient();
  const { data: qrBruto } = await admin
    .from("qr_codes")
    .select("id, organization_id, codigo, mensagem, arquivado_em, channel_session_id")
    .eq("codigo", codigo)
    .maybeSingle();
  const qr = qrBruto as QrDaRota | null;
  if (!qr) return inativo();
  if (qr.arquivado_em) {
    return pagina(410, "QR code desativado", "Este QR code não está mais ativo.");
  }

  // O número: o do canal escolhido no QR; se ele sumiu ou não tem telefone, o primeiro canal da MESMA
  // organização que esteja conectado e tenha número.
  let telefone: string | null = null;
  if (qr.channel_session_id) {
    const { data } = await admin
      .from("channel_sessions")
      .select("phone_number")
      .eq("organization_id", qr.organization_id)
      .eq("id", qr.channel_session_id)
      .maybeSingle();
    telefone = (data as { phone_number: string | null } | null)?.phone_number ?? null;
  }
  if (!telefone) {
    const { data } = await admin
      .from("channel_sessions")
      .select("phone_number")
      .eq("organization_id", qr.organization_id)
      .eq("status", "WORKING")
      .not("phone_number", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    telefone = (data as { phone_number: string | null } | null)?.phone_number ?? null;
  }
  const destino = linkDoWhatsApp(telefone, qr.mensagem, qr.codigo);
  if (!destino) {
    return pagina(
      503,
      "QR code sem número",
      "Este QR code ainda não está ligado a um número de WhatsApp. Avise a empresa que o divulgou.",
    );
  }

  const ua = req.headers.get("user-agent");
  if (!ehLeituraDeRobo(ua)) {
    const ip = ipDoCliente(req.headers) ?? "sem-ip";
    const limite = await checkRateLimit(`qr_leitura:${qr.id}:${ip}`, LEITURAS_POR_MINUTO, 60);
    if (limite.allowed) {
      const { error } = await admin.from("qr_code_leituras").insert({
        organization_id: qr.organization_id,
        qr_code_id: qr.id,
        dispositivo: dispositivoDoAgente(ua),
      });
      if (error) {
        logger.warn("qr: leitura não gravada (a pessoa segue para o WhatsApp)", {
          qr_code_id: qr.id,
          detail: error.message.slice(0, 160),
        });
      }
    }
  }

  return NextResponse.redirect(destino, { status: 302, headers: SEM_CACHE });
}
```

Notas para o executor: confira a assinatura real de `ipDoCliente` em `lib/http/ip-do-cliente.ts` (recebe `Headers`)
e o campo de retorno de `checkRateLimit` (`allowed`). Se o mock do teste não refletir o builder usado (`.not`,
`.order`, `.limit`), ajuste o mock — não a rota.

- [ ] **Step 4: Liberar a rota no proxy**

Em `lib/auth/public-paths.ts`, acrescente ao array (antes de `/^\/_next\//`), com o comentário:

```ts
  // O QR impresso (`app/q/[codigo]/route.ts`). Quem lê é o CLIENTE da empresa, sem conta nenhuma — exigir sessão
  // mandaria para o login quem só queria abrir o WhatsApp. Ancorado: só `/q/<código>`, nada abaixo.
  /^\/q\/[A-Za-z0-9]{1,16}$/,
```

Procure um teste de rotas públicas (`grep -rln "isPublicPath\|PUBLIC_PATHS" tests lib --include=*.test.ts`) e, se
existir, acrescente os casos `/q/R7K2QH` → público e `/q/R7K2QH/x` → não público.

- [ ] **Step 5: Rodar e ver passar** — `pnpm exec vitest run "app/q" lib/auth` → PASS.

- [ ] **Step 6: Commit**

```bash
git add app/q lib/auth
git commit -m "feat(qr): rota pública /q/<código> conta a leitura e abre o WhatsApp

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reconhecer o QR na mensagem que chega e dar origem ao lead

**Files:**
- Create: `lib/qr-codes/reconhecer.ts`, `lib/qr-codes/reconhecer.test.ts`
- Modify: `lib/leads/nascimento-do-lead.ts`, `lib/channels/pos-entrada.ts`, `tests/unit/pos-entrada-efeitos-do-canal.test.ts`
- Test: o teste existente de nascimento (`grep -rln "garantirLeadDaConversa" tests lib --include=*.test.ts`)

**Interfaces:**
- Produces: `interface QrReconhecido { id: string; nome: string; codigo: string }`,
  `reconhecerQrCodeNaEntrada(admin, { organizationId, conversationId, contactId, messageId, texto }) → Promise<QrReconhecido | null>`,
  `origemDoQr(qr) → OrigemDoNascimento`, `vincularLeadAoQr(admin, { organizationId, conversationId, qrCodeId, leadId }) → Promise<void>`,
  `ROTULO_DA_TAG_DE_QR = "QR code"`.
- Produces (nascimento): `export interface OrigemDoNascimento { source: string; sourceMetadata: Record<string, unknown>; tags: string[] }`,
  `DadosDoNascimento.origem?: OrigemDoNascimento`.

- [ ] **Step 1: Testes (falham)**

`lib/qr-codes/reconhecer.test.ts` — admin falso com `from(tabela)` que registra chamadas; casos:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { origemDoQr, reconhecerQrCodeNaEntrada, vincularLeadAoQr } from "./reconhecer";

let conversa: { is_group: boolean } | null;
let qr: { id: string; nome: string; codigo: string } | null;
let erroDoInsert: { code?: string; message: string } | null;
const inserts: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
const updates: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
let leituras = 0;

const admin = {
  from(tabela: string) {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => {
        leituras++;
        return { data: tabela === "conversations" ? conversa : qr, error: null };
      },
      insert: async (linha: Record<string, unknown>) => {
        inserts.push({ tabela, linha });
        return { error: erroDoInsert };
      },
      update: (linha: Record<string, unknown>) => {
        updates.push({ tabela, linha });
        return b;
      },
      then: (r: (v: unknown) => void) => Promise.resolve({ error: null }).then(r),
    });
    return b;
  },
} as never;

const ENTRADA = {
  organizationId: "org-1",
  conversationId: "conv-1",
  contactId: "ct-1",
  messageId: "msg-1",
  texto: "Olá! Vi o cartaz #R7K2QH",
};

beforeEach(() => {
  conversa = { is_group: false };
  qr = { id: "qr-1", nome: "Cartaz da recepção", codigo: "R7K2QH" };
  erroDoInsert = null;
  inserts.length = 0;
  updates.length = 0;
  leituras = 0;
});

describe("reconhecerQrCodeNaEntrada", () => {
  it("mensagem SEM código não toca o banco", async () => {
    expect(await reconhecerQrCodeNaEntrada(admin, { ...ENTRADA, texto: "oi, tudo bem?" })).toBeNull();
    expect(leituras).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("código da org: grava a conversa e devolve o QR", async () => {
    expect(await reconhecerQrCodeNaEntrada(admin, ENTRADA)).toEqual(qr);
    expect(inserts).toEqual([
      {
        tabela: "qr_code_conversas",
        linha: {
          organization_id: "org-1",
          qr_code_id: "qr-1",
          conversation_id: "conv-1",
          contact_id: "ct-1",
          message_id: "msg-1",
        },
      },
    ]);
  });

  it("conversa já contada (23505) ainda devolve o QR — o lead novo precisa da origem", async () => {
    erroDoInsert = { code: "23505", message: "duplicate" };
    expect(await reconhecerQrCodeNaEntrada(admin, ENTRADA)).toEqual(qr);
  });

  it("grupo não conta", async () => {
    conversa = { is_group: true };
    expect(await reconhecerQrCodeNaEntrada(admin, ENTRADA)).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("código que não é desta organização é ignorado", async () => {
    qr = null;
    expect(await reconhecerQrCodeNaEntrada(admin, ENTRADA)).toBeNull();
    expect(inserts).toHaveLength(0);
  });
});

describe("origemDoQr e vincularLeadAoQr", () => {
  it("a origem leva id, nome e código, e a tag 'QR code'", () => {
    expect(origemDoQr({ id: "qr-1", nome: "Cartaz", codigo: "R7K2QH" })).toEqual({
      source: "qr_code",
      sourceMetadata: { qr_code_id: "qr-1", qr_code_nome: "Cartaz", qr_code_codigo: "R7K2QH" },
      tags: ["QR code"],
    });
  });

  it("vincular grava o lead_id na conversa do QR", async () => {
    await vincularLeadAoQr(admin, { organizationId: "org-1", conversationId: "conv-1", qrCodeId: "qr-1", leadId: "lead-9" });
    expect(updates).toEqual([{ tabela: "qr_code_conversas", linha: { lead_id: "lead-9" } }]);
  });
});
```

Em `tests/unit/pos-entrada-efeitos-do-canal.test.ts`, mocke o módulo novo (padrão do arquivo) e acrescente um
`describe("o QR da mensagem")` com três casos:

```ts
const reconhecer = vi.fn(async () => null as unknown);
const vincular = vi.fn(async () => {});
vi.mock("@/lib/qr-codes/reconhecer", async (orig) => ({
  ...(await orig<typeof import("@/lib/qr-codes/reconhecer")>()),
  reconhecerQrCodeNaEntrada: (...a: unknown[]) => {
    sequencia.push("qr");
    return reconhecer(...(a as []));
  },
  vincularLeadAoQr: (...a: unknown[]) => vincular(...(a as [])),
}));
```

Casos: (1) a ordem é opt-out → `qr` → lead (o `garantirLeadDaConversa` mockado vê `"qr"` na `sequencia` e o opt-out
antes dele); (2) com `reconhecer` devolvendo `{ id: "qr-1", nome: "Cartaz", codigo: "R7K2QH" }`, o segundo argumento
de `garantirLeadDaConversa` tem `origem.source === "qr_code"` e `vincular` é chamado com `leadId: "lead-1"`;
(3) com `reconhecer` lançando erro, o lead nasce mesmo assim, sem `origem`. Zere `reconhecer`/`vincular` no
`beforeEach`.

No teste de nascimento existente, acrescente: com `origem` passada, o insert em `crm_leads` usa `source:
"qr_code"`, o `source_metadata` e as `tags` dela **mesmo que o contato tenha `source = 'meta_ads'`**; sem
`origem`, o comportamento atual (anúncio > whatsapp) não muda.

- [ ] **Step 2: Rodar e ver falhar** — `pnpm exec vitest run lib/qr-codes tests/unit/pos-entrada-efeitos-do-canal.test.ts` → FAIL.

- [ ] **Step 3: Implementar `lib/qr-codes/reconhecer.ts`**

```ts
/**
 * PASSO 1b DA ENTRADA: A MENSAGEM VEIO DE UM QR?
 *
 * A mensagem pronta do QR termina em `#CÓDIGO`. Aqui ela é casada com o QR da MESMA organização, a conversa é
 * registrada (uma vez por QR) e o QR volta para quem vai abrir a demanda — o lead NOVO nasce com origem QR.
 * Lead já aberto não muda de origem (primeiro toque, decisão do dono): só a conversa entra na conta do QR.
 *
 * Mensagem sem código não toca o banco — é o caso de quase toda mensagem, e ele tem de custar zero.
 * Nada aqui derruba a ingestão: falha vira log e o lead nasce sem origem de QR.
 */
import { extrairCodigoDaMensagem } from "@/lib/qr-codes/codigo";
import type { OrigemDoNascimento } from "@/lib/leads/nascimento-do-lead";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export const ROTULO_DA_TAG_DE_QR = "QR code";

export interface QrReconhecido {
  id: string;
  nome: string;
  codigo: string;
}

export interface MensagemParaReconhecer {
  organizationId: string;
  conversationId: string;
  contactId: string;
  messageId: string | null;
  texto: string | null;
}

export async function reconhecerQrCodeNaEntrada(
  admin: Admin,
  m: MensagemParaReconhecer,
): Promise<QrReconhecido | null> {
  const codigo = extrairCodigoDaMensagem(m.texto);
  if (!codigo) return null;

  try {
    // Atribuição é sobre a PESSOA que leu o QR; num grupo, quem escreveu é um participante.
    const { data: conversa } = await admin
      .from("conversations")
      .select("is_group")
      .eq("organization_id", m.organizationId)
      .eq("id", m.conversationId)
      .maybeSingle();
    if ((conversa as { is_group: boolean } | null)?.is_group) return null;

    // Arquivado CONTA: arquivar tira o QR de circulação, não apaga o fato de que alguém chegou por ele.
    const { data: qrBruto } = await admin
      .from("qr_codes")
      .select("id, nome, codigo")
      .eq("organization_id", m.organizationId)
      .eq("codigo", codigo)
      .maybeSingle();
    const qr = qrBruto as QrReconhecido | null;
    if (!qr) return null;

    const { error } = await admin.from("qr_code_conversas").insert({
      organization_id: m.organizationId,
      qr_code_id: qr.id,
      conversation_id: m.conversationId,
      contact_id: m.contactId,
      message_id: m.messageId,
    });
    // 23505 = esta conversa já foi contada para este QR. Não é erro, e o QR continua valendo para o lead.
    if (error && error.code !== "23505") {
      logger.warn("qr: conversa não registrada (o lead segue)", {
        organization_id: m.organizationId,
        qr_code_id: qr.id,
        detail: error.message.slice(0, 160),
      });
    }
    return qr;
  } catch (err) {
    logger.warn("qr: reconhecimento falhou (a mensagem entra sem origem de QR)", {
      organization_id: m.organizationId,
      conversation_id: m.conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return null;
  }
}

export function origemDoQr(qr: QrReconhecido): OrigemDoNascimento {
  return {
    source: "qr_code",
    sourceMetadata: { qr_code_id: qr.id, qr_code_nome: qr.nome, qr_code_codigo: qr.codigo },
    tags: [ROTULO_DA_TAG_DE_QR],
  };
}

/** O lead que nasceu desta conversa fica ligado à linha do QR (o funil do QR conta leads pelo lead). */
export async function vincularLeadAoQr(
  admin: Admin,
  v: { organizationId: string; conversationId: string; qrCodeId: string; leadId: string },
): Promise<void> {
  const { error } = await admin
    .from("qr_code_conversas")
    .update({ lead_id: v.leadId })
    .eq("organization_id", v.organizationId)
    .eq("qr_code_id", v.qrCodeId)
    .eq("conversation_id", v.conversationId);
  if (error) {
    logger.warn("qr: lead não vinculado à conversa do QR", {
      organization_id: v.organizationId,
      qr_code_id: v.qrCodeId,
      detail: error.message.slice(0, 160),
    });
  }
}
```

(O `admin` falso do teste usa `then` no builder do `update` — se o tipo do Supabase reclamar no teste, mantenha o
`as never` do admin.)

- [ ] **Step 4: `garantirLeadDaConversa` aceita `origem`**

Em `lib/leads/nascimento-do-lead.ts`:

1. Exporte o tipo, perto de `DadosDoNascimento`:

```ts
/**
 * De onde o NEGÓCIO veio, quando quem chama sabe melhor que o contato — hoje, o QR lido nesta mensagem
 * (`lib/qr-codes/reconhecer.ts`). Precedência: esta origem > o anúncio estampado no contato > "whatsapp".
 * O QR da mensagem vence o anúncio porque é sobre ESTA demanda; o anúncio é sobre a primeira vez da pessoa.
 */
export interface OrigemDoNascimento {
  source: string;
  sourceMetadata: Record<string, unknown>;
  tags: string[];
}
```

2. Em `DadosDoNascimento`, acrescente `origem?: OrigemDoNascimento;` com comentário de uma linha.

3. Troque o bloco do insert (hoje `source: rotuloDeAnuncio ? ... : "whatsapp"`, `source_metadata: ...`,
   `tags: ...`) por:

```ts
  const origemDoAnuncio: OrigemDoNascimento | null = rotuloDeAnuncio
    ? { source: contato!.source as string, sourceMetadata: (contato!.source_metadata ?? {}) as Record<string, unknown>, tags: [rotuloDeAnuncio] }
    : null;
  const origem: OrigemDoNascimento = dados.origem ?? origemDoAnuncio ?? { source: "whatsapp", sourceMetadata: {}, tags: [] };
```

   e no `.insert({...})`: `source: origem.source, source_metadata: origem.sourceMetadata, tags: origem.tags,`.

4. No `emitLeadActivity`, troque `payload: { conversation_id: conversationId }` por
   `payload: { conversation_id: conversationId, origem: origem.source, ...origem.sourceMetadata }`.

- [ ] **Step 5: `pos-entrada` chama o passo 1b**

Em `lib/channels/pos-entrada.ts`:

1. Import: `import { origemDoQr, reconhecerQrCodeNaEntrada, vincularLeadAoQr, type QrReconhecido } from "@/lib/qr-codes/reconhecer";`
2. No cabeçalho, na lista da ORDEM, acrescente entre 1 e 2:

```
 *   1b. QR      — a mensagem traz `#CÓDIGO` de um QR desta organização? A conversa entra na conta do QR e o
 *                 lead que nascer no passo 2 leva a origem dele. Depois do opt-out (quem pediu para sair não
 *                 vira lead, com ou sem QR) e ANTES do lead (senão ele nasceria "whatsapp").
```

3. Em `aplicarEfeitosPosEntrada`:

```ts
  await aplicarOptOut(admin, entrada);
  const qr = await reconhecerQr(admin, entrada);
  await abrirDemanda(admin, entrada, qr);
```

4. Função nova (abaixo de `aplicarOptOut`):

```ts
/** 1b · A mensagem veio de um QR? Nunca lança: sem QR reconhecido, o lead nasce como sempre nasceu. */
async function reconhecerQr(admin: Admin, entrada: EntradaDeMensagem): Promise<QrReconhecido | null> {
  try {
    return await reconhecerQrCodeNaEntrada(admin, {
      organizationId: entrada.organizationId,
      conversationId: entrada.conversationId,
      contactId: entrada.contactId,
      messageId: entrada.messageId,
      texto: entrada.texto,
    });
  } catch (err) {
    logger.warn("pos-entrada: QR não reconhecido (o lead segue sem origem de QR)", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return null;
  }
}
```

5. `abrirDemanda(admin, entrada, qr: QrReconhecido | null)`: passe `...(qr ? { origem: origemDoQr(qr) } : {})` no
   objeto de `garantirLeadDaConversa`, e depois do log:

```ts
    if (qr && nascimento.criado) {
      await vincularLeadAoQr(admin, {
        organizationId: entrada.organizationId,
        conversationId: entrada.conversationId,
        qrCodeId: qr.id,
        leadId: nascimento.leadId,
      });
    }
```

   Acrescente `qr_code_id: qr?.id ?? null` ao objeto do `logger.info` do nascimento.

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm exec vitest run lib/qr-codes tests/unit/pos-entrada-efeitos-do-canal.test.ts` + o teste de nascimento
achado no passo 1 + `grep -rln "pos-entrada" tests/unit` (rode todos). Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib tests/unit
git commit -m "feat(qr): a mensagem com #código conta no QR e o lead novo nasce com a origem dele

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API dos QR codes (listar, criar, editar, arquivar)

**Files:**
- Create: `lib/schemas/qr-codes.ts`, `lib/schemas/qr-codes.test.ts`, `app/api/v1/qr-codes/route.ts`,
  `app/api/v1/qr-codes/[id]/route.ts`, `app/api/v1/qr-codes/route.test.ts`
- Modify: `lib/audit/actions.ts`

**Interfaces:**
- Consumes: `gerarCodigo` (Task 2), `requireRole`, `createClient` (`@/lib/supabase/server`), `audit`, `ok`/`fail`.
- Produces: `GET /api/v1/qr-codes` → `{ data: { qr_codes: QrCodeRow[], canais: CanalDoQr[] } }`;
  `POST /api/v1/qr-codes` body `{ nome, mensagem, channel_session_id }` → `{ data: QrCodeRow }` (201);
  `PATCH /api/v1/qr-codes/[id]` body `{ nome?, mensagem?, channel_session_id?, arquivado? }` → `{ data: QrCodeRow }`.
  Tipos exportados de `lib/schemas/qr-codes.ts`: `QrCodeRow`, `CanalDoQr`, `criarQrCodeSchema`, `editarQrCodeSchema`.

- [ ] **Step 1: Ações de auditoria**

No FIM do array de `lib/audit/actions.ts`:

```ts
  // QR codes rastreáveis (migration 0220): quem criou, mudou, tirou de circulação ou devolveu um QR impresso.
  // A LEITURA não entra aqui: é pública, sem ator, e de alto volume — ela é contada em `qr_code_leituras`.
  "qr_code.created",
  "qr_code.updated",
  "qr_code.archived",
  "qr_code.restored",
```

- [ ] **Step 2: Schemas + teste**

`lib/schemas/qr-codes.ts`:

```ts
import { z } from "zod";

const texto = (max: number) =>
  z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(1).max(max));

export const criarQrCodeSchema = z.object({
  nome: texto(80),
  mensagem: texto(300),
  channel_session_id: z.string().uuid(),
});
export type CriarQrCodeInput = z.infer<typeof criarQrCodeSchema>;

export const editarQrCodeSchema = z
  .object({
    nome: texto(80).optional(),
    mensagem: texto(300).optional(),
    channel_session_id: z.string().uuid().optional(),
    arquivado: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nada para mudar." });
export type EditarQrCodeInput = z.infer<typeof editarQrCodeSchema>;

export interface QrCodeRow {
  id: string;
  codigo: string;
  nome: string;
  mensagem: string;
  channel_session_id: string | null;
  arquivado_em: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanalDoQr {
  id: string;
  nome: string | null;
  telefone: string | null;
  conectado: boolean;
}

export const COLUNAS_DO_QR =
  "id, codigo, nome, mensagem, channel_session_id, arquivado_em, created_at, updated_at";
```

`lib/schemas/qr-codes.test.ts`: casos — nome com espaços em volta é aparado; nome vazio/só espaço recusa; mensagem
de 301 chars recusa; `channel_session_id` não-uuid recusa; `editarQrCodeSchema` com `{}` recusa; com
`{ arquivado: true }` aceita.

- [ ] **Step 3: Rotas**

`app/api/v1/qr-codes/route.ts`:

```ts
/**
 * GET/POST /api/v1/qr-codes — os QR codes da organização (gestor+).
 *
 * A RLS de `qr_codes` também exige manager: a porta HTTP e a do PostgREST concordam. Criar usa o cliente da
 * SESSÃO (não o admin): a policy de INSERT é a segunda cerca, e o `organization_id` vem da org ativa, nunca do body.
 * O código é sorteado aqui; colisão (unique da instalação) é re-sorteada até 5 vezes.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { gerarCodigo } from "@/lib/qr-codes/codigo";
import { COLUNAS_DO_QR, criarQrCodeSchema, type CanalDoQr, type QrCodeRow } from "@/lib/schemas/qr-codes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "qr_codes", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const supabase = await createClient();
  const [{ data: qrs, error: e1 }, { data: canais, error: e2 }] = await Promise.all([
    supabase
      .from("qr_codes")
      .select(COLUNAS_DO_QR)
      .eq("organization_id", orgId)
      .order("arquivado_em", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("channel_sessions")
      .select("id, display_name, phone_number, status")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true }),
  ]);
  if (e1) return fail("internal_error", e1.message, 500, { requestId });
  if (e2) return fail("internal_error", e2.message, 500, { requestId });

  const listaDeCanais: CanalDoQr[] = (
    (canais ?? []) as Array<{ id: string; display_name: string | null; phone_number: string | null; status: string }>
  ).map((c) => ({ id: c.id, nome: c.display_name, telefone: c.phone_number, conectado: c.status === "WORKING" }));

  return ok({ qr_codes: (qrs ?? []) as QrCodeRow[], canais: listaDeCanais }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "qr_codes", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const corpo = await req.json().catch(() => null);
  const parsed = criarQrCodeSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const input = parsed.data;

  const supabase = await createClient();
  const { data: canal } = await supabase
    .from("channel_sessions")
    .select("id, phone_number")
    .eq("organization_id", orgId)
    .eq("id", input.channel_session_id)
    .maybeSingle();
  if (!canal) return fail("validation_failed", "Número de WhatsApp não encontrado.", 422, { requestId });
  if (!(canal as { phone_number: string | null }).phone_number) {
    return fail("validation_failed", "Este número ainda não tem telefone conectado.", 422, { requestId });
  }

  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { data, error } = await supabase
      .from("qr_codes")
      .insert({
        organization_id: orgId,
        codigo: gerarCodigo(),
        nome: input.nome,
        mensagem: input.mensagem,
        channel_session_id: input.channel_session_id,
        created_by_user_id: authz.user.id,
      })
      .select(COLUNAS_DO_QR)
      .single();
    if (error?.code === "23505") continue;
    if (error || !data) return fail("internal_error", error?.message ?? "Falha ao criar.", 500, { requestId });

    const criado = data as QrCodeRow;
    await audit({
      action: "qr_code.created",
      organizationId: orgId,
      actorUserId: authz.user.id,
      resourceType: "qr_code",
      resourceId: criado.id,
      requestId,
      metadata: { codigo: criado.codigo, nome: criado.nome },
    });
    return ok(criado, { requestId, status: 201 });
  }
  return fail("internal_error", "Não foi possível gerar um código único. Tente de novo.", 500, { requestId });
}
```

> Confira em `lib/api/wrappers.ts` se `ok()` aceita `status` nas opções; se não aceitar, use o formato que as
> outras rotas de criação usam (`grep -rn "201" app/api/v1 --include=route.ts | head`).

`app/api/v1/qr-codes/[id]/route.ts`:

```ts
/**
 * PATCH /api/v1/qr-codes/[id] — renomear, trocar a mensagem ou o número, arquivar/reativar (gestor+).
 *
 * O CÓDIGO nunca muda: ele está impresso. Mudar a mensagem vale para as próximas leituras; quem já leu e não
 * mandou continua com a mensagem antiga no celular — por isso o código, e não a frase, é o que identifica.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DO_QR, editarQrCodeSchema, type QrCodeRow } from "@/lib/schemas/qr-codes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "qr_codes", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const { id } = await ctx.params;

  const parsed = editarQrCodeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const input = parsed.data;
  const supabase = await createClient();

  if (input.channel_session_id) {
    const { data: canal } = await supabase
      .from("channel_sessions")
      .select("id, phone_number")
      .eq("organization_id", orgId)
      .eq("id", input.channel_session_id)
      .maybeSingle();
    if (!canal || !(canal as { phone_number: string | null }).phone_number) {
      return fail("validation_failed", "Este número não está disponível para QR code.", 422, { requestId });
    }
  }

  const mudanca: Record<string, unknown> = {};
  if (input.nome !== undefined) mudanca.nome = input.nome;
  if (input.mensagem !== undefined) mudanca.mensagem = input.mensagem;
  if (input.channel_session_id !== undefined) mudanca.channel_session_id = input.channel_session_id;
  if (input.arquivado !== undefined) mudanca.arquivado_em = input.arquivado ? new Date().toISOString() : null;

  const { data, error } = await supabase
    .from("qr_codes")
    .update(mudanca)
    .eq("organization_id", orgId)
    .eq("id", id)
    .select(COLUNAS_DO_QR)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("resource_not_found", "QR code não encontrado.", 404, { requestId });

  const qr = data as QrCodeRow;
  const acao =
    input.arquivado === true ? "qr_code.archived" : input.arquivado === false ? "qr_code.restored" : "qr_code.updated";
  await audit({
    action: acao,
    organizationId: orgId,
    actorUserId: authz.user.id,
    resourceType: "qr_code",
    resourceId: qr.id,
    requestId,
    metadata: { campos: Object.keys(mudanca) },
  });
  return ok(qr, { requestId });
}
```

- [ ] **Step 4: Teste das rotas**

`app/api/v1/qr-codes/route.test.ts` (`// @vitest-environment node`): mocke `@/lib/auth/require-role`
(`requireRole` → `{ ok: true, user: { id: "u-1" }, org: { orgId: "org-1" } }`, e um caso `{ ok: false, response:
new Response(null, { status: 403 }) }`), `@/lib/audit` e `@/lib/supabase/server` (builder falso). Casos: GET sem
papel → 403; POST com canal sem telefone → 422; POST feliz → 201, `codigo` casa `/^[2-9A-HJKMNP-Z]{6}$/`,
`audit` chamado com `qr_code.created`; POST com 23505 na 1ª tentativa e sucesso na 2ª → 201 (o insert foi chamado
duas vezes); PATCH `{ arquivado: true }` → `audit` com `qr_code.archived` e `arquivado_em` preenchido; PATCH de id
de outra org (builder devolve `data: null`) → 404.

- [ ] **Step 5: Rodar e ver passar** — `pnpm exec vitest run lib/schemas/qr-codes.test.ts "app/api/v1/qr-codes"` + os
  guardas de auditoria (`pnpm exec vitest run tests/unit/audit`). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/schemas lib/audit app/api/v1/qr-codes
git commit -m "feat(qr): API de QR codes para gestor — criar, editar, arquivar

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Agregação do relatório e as rotas de leitura

**Files:**
- Create: `lib/relatorios/origens.ts`, `lib/relatorios/origens.test.ts`, `lib/schemas/relatorios.ts`,
  `app/api/v1/relatorios/origens/route.ts`, `app/api/v1/relatorios/qr-codes/route.ts`

**Interfaces:**
- Produces (`lib/relatorios/origens.ts`):
  - `type GrupoDeOrigem = "qr" | "anuncio" | "formulario" | "whatsapp" | "manual" | "importado" | "ia" | "outros"`
  - `ORDEM_DOS_GRUPOS: GrupoDeOrigem[]`, `ROTULO_DO_GRUPO: Record<GrupoDeOrigem, string>` (rótulos pt para `t()`)
  - `grupoDaOrigem(source: string) → GrupoDeOrigem`
  - `interface LinhaDeOrigem { source; detalhe; leads; abertos; ganhos; perdidos; valor_ganho_cents }` (números já `Number`)
  - `interface Totais { leads; abertos; ganhos; perdidos; valorGanhoCents; conversao: number | null }`
  - `interface DetalheDoGrupo extends Totais { chave: string; rotulo: string }`
  - `interface GrupoDoRelatorio extends Totais { grupo: GrupoDeOrigem; detalhes: DetalheDoGrupo[] }`
  - `agruparOrigens(linhas, nomes: { qr: Map<string,string>; fonte: Map<string,string> }) → { grupos: GrupoDoRelatorio[]; total: Totais }`
  - `serieDiaria(linhas: { dia: string; source: string; leads: number }[], de: Date, ate: Date, fuso: string) → Array<{ dia: string } & Record<GrupoDeOrigem, number>>`
  - `conversao(ganhos, perdidos) → number | null` = ganhos / (ganhos + perdidos), `null` se ninguém fechou.
- Produces (`lib/schemas/relatorios.ts`): `periodoSchema` (query `de`, `ate` ISO date `YYYY-MM-DD`, `fuso` IANA,
  limites: `ate > de`, no máximo 366 dias) → `{ de: Date (00:00 no fuso), ate: Date (00:00 do dia SEGUINTE a ate), fuso }`.
- Produces (rotas): `GET /api/v1/relatorios/origens?de&ate&fuso` →
  `{ data: { grupos, total, serie } }`; `GET /api/v1/relatorios/qr-codes?de&ate&fuso` →
  `{ data: { funil: Array<{ qr_code_id; leituras; conversas; leads; ganhos; valor_ganho_cents }> } }`.

**Regras de `grupoDaOrigem`:** `qr_code`→qr · `meta_ads`,`google_ads`→anuncio · `webhook`→formulario ·
`whatsapp`→whatsapp · `manual`→manual · `import`,`importacao`,`csv`,`planilha`→importado ·
`agent`,`ai_agent`,`reactivation`→ia · resto→outros.

**Rótulo do detalhe:** qr → nome do QR pelo mapa (QR apagado do mapa: "QR removido"); anuncio → o próprio
`detalhe` (título do anúncio) ou "Anúncio sem título"; formulario → `detalhe` começando com `fonte:` vira o nome da
fonte pelo mapa (`"Formulário sem campanha"` se não achar), senão a campanha/utm como veio; demais grupos → um
detalhe só, com o rótulo do grupo. Detalhes ordenados por leads desc; grupos na `ORDEM_DOS_GRUPOS` e só os que têm
leads. `ROTULO_DO_GRUPO`: qr "QR codes", anuncio "Anúncios", formulario "Formulários", whatsapp "WhatsApp direto",
manual "Criados à mão", importado "Importados", ia "IA e retomadas", outros "Outras origens".

- [ ] **Step 1: Testes da agregação (falham)**

`lib/relatorios/origens.test.ts` — casos obrigatórios:
1. `grupoDaOrigem` para cada valor da tabela acima e um desconhecido (`"landing"` → outros).
2. Duas linhas `qr_code` de QRs diferentes viram UM grupo "qr" com dois detalhes rotulados pelo nome, e os totais
   do grupo somam os dois.
3. `webhook` com `detalhe = "fonte:<uuid>"` vira o nome da fonte; com `detalhe = "black-friday"` fica "black-friday".
4. `conversao`: 3 ganhos e 1 perdido → 0.75; 0 e 0 → `null` (não "0%": ninguém fechou ainda).
5. Total geral soma tudo e `valorGanhoCents` soma os ganhos.
6. `serieDiaria` preenche os dias SEM lead com zero (o gráfico não pode pular dia) e soma por grupo.

- [ ] **Step 2: Rodar e ver falhar** — `pnpm exec vitest run lib/relatorios` → FAIL.

- [ ] **Step 3: Implementar `lib/relatorios/origens.ts`** com as interfaces acima. Para `serieDiaria`, gere os dias
  com `Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" })`
  (formato `YYYY-MM-DD`) avançando 24h a partir de `de` até `< ate`, deduplicando (horário de verão pode repetir).

- [ ] **Step 4: `lib/schemas/relatorios.ts`**

Use `z.object({ de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ate: ..., fuso: z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/).default("America/Sao_Paulo") })`
e um `transform` que valida o fuso com `Intl.DateTimeFormat(undefined, { timeZone })` (lança → 422) e converte
`de`/`ate` para o instante 00:00 NAQUELE fuso. Teste em `lib/schemas/relatorios.test.ts`: período invertido → erro;
367 dias → erro; fuso inválido → erro; `ate` é exclusivo (o dia final inteiro entra).

- [ ] **Step 5: Rotas**

`app/api/v1/relatorios/origens/route.ts`: `requireRole("manager", { requestId, resource: "relatorios", allowPlatformAdmin: true })`;
valida `periodoSchema` com os `searchParams`; com `createClient()` chama em paralelo
`supabase.rpc("fn_relatorio_de_origens", { p_org, p_de, p_ate })`,
`supabase.rpc("fn_relatorio_de_origens_por_dia", { p_org, p_de, p_ate, p_fuso })`,
`supabase.from("qr_codes").select("id, nome").eq("organization_id", org)` e
`supabase.from("webhook_sources").select("id, name").eq("organization_id", org)`; converte os `bigint` com `Number()`;
devolve `ok({ grupos, total, serie }, { requestId })`. Erro de RPC → 500 com a mensagem.

`app/api/v1/relatorios/qr-codes/route.ts`: mesmo gate e período; `rpc("fn_relatorio_de_qr_codes", ...)`; devolve
`ok({ funil }, { requestId })` com números convertidos.

Cabeçalho de cada rota: um parágrafo dizendo que o gate é manager, que a função é `security invoker` (a RLS vale
através dela) e que agregar no banco é obrigatório (corte de 1.000 linhas do PostgREST).

- [ ] **Step 6: Rodar e ver passar** — `pnpm exec vitest run lib/relatorios lib/schemas/relatorios.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/relatorios lib/schemas app/api/v1/relatorios
git commit -m "feat(relatorios): agregação por origem e funil do QR, gestor+

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Navegação — a sexta aba (gestor+)

**Files:**
- Modify: `lib/navigation/registry.ts`, `tests/unit/navegacao-registry.test.ts`
- Verify: `components/shell/AbasPrincipais.tsx` (barra com 6 abas cabe?)

- [ ] **Step 1: Ajustar o teste PRIMEIRO**

Em `tests/unit/navegacao-registry.test.ts`, no `describe("abasPrincipais — a barra superior")`:
- "são CINCO abas…" vira dois casos: para platform admin / manager a lista é
  `["/app/inbox","/app/contacts","/app/kanban","/app/agenda","/app/ai","/app/relatorios"]`; para `agent` e `viewer`
  a lista continua a de cinco (sem `/app/relatorios`). Use os helpers de papel que o arquivo já tem (`VIEWER`).
- "uma aba por linha…": `toBeLessThanOrEqual(6)`, e o comentário passa a dizer: "Cinco para quem atende; a sexta
  (Relatórios) é decisão do dono em 2026-10-28 e só aparece para gestor+. Uma sétima é a volta do menu lateral."

- [ ] **Step 2: Rodar e ver falhar** — `pnpm exec vitest run tests/unit/navegacao-registry.test.ts` → FAIL.

- [ ] **Step 3: Registry**

Em `NAV_DESTINATIONS`, no grupo `"analise"` (perto de `/app/metrics`), acrescente:

```ts
  {
    // A SEXTA ABA, e só para gestor+ (decisão do dono, 2026-10-28): de onde os leads vêm até a venda. Quem atende
    // continua com cinco abas — para o atendente esta tela não existe (a rota redireciona).
    href: "/app/relatorios",
    label: "Relatórios",
    description: "De onde vêm os leads — QR codes, anúncios, formulários — e quantos viram venda.",
    icon: ChartLineUp,
    group: "analise",
    minRole: "manager",
    principal: 6,
  },
  {
    href: "/app/relatorios/qr-codes",
    label: "QR codes",
    description: "Crie QR codes para cartaz e panfleto e veja quantos leram, conversaram e compraram.",
    icon: QrCode,
    group: "analise",
    minRole: "manager",
  },
```

Importe `QrCode` de `@/lib/ui/icons` (já exportado; `ChartLineUp` já é importado no arquivo).

- [ ] **Step 4: Rodar e ver passar** — `pnpm exec vitest run tests/unit/navegacao-registry.test.ts tests/unit/navegacao-completude.test.ts tests/unit/nav-hub.test.tsx`.
  O `navegacao-completude` só passa depois que as páginas existirem (Tasks 8 e 9) — se falhar agora por isso, siga e
  rode de novo ao fim da Task 9.

- [ ] **Step 5: Commit**

```bash
git add lib/navigation tests/unit/navegacao-registry.test.ts
git commit -m "feat(nav): aba Relatórios para gestor+ e QR codes no inventário

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Tela de relatório de origens

**Files:**
- Create: `hooks/relatorios/useRelatorioDeOrigens.ts`, `app/app/relatorios/page.tsx`,
  `app/app/relatorios/_components/RelatoriosClient.tsx`, `app/app/relatorios/_components/FiltroDePeriodo.tsx`,
  `app/app/relatorios/_components/ResumoDoPeriodo.tsx`, `app/app/relatorios/_components/TabelaDeOrigens.tsx`,
  `app/app/relatorios/_components/GraficoPorDia.tsx`, `lib/relatorios/periodo.ts` (+ `.test.ts`)
- Modify: `lib/i18n/dicionario.ts`
- Test: `tests/unit/relatorios-tela.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/relatorios/origens` (Task 6), tipos de `lib/relatorios/origens.ts`.
- Produces: `periodoPreDefinido(dias: 7|30|90, agora: Date, fuso: string) → { de: string; ate: string }` (datas
  `YYYY-MM-DD`, `ate` = hoje no fuso), `useRelatorioDeOrigens({ de, ate, fuso })`.

- [ ] **Step 1: Página (servidor) com gate**

`app/app/relatorios/page.tsx` — molde de `app/app/webhooks/page.tsx`: `requireAuth`, `resolveActiveOrg`,
`ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager` (ou platform admin) senão `redirect("/app/inbox")`; título
"Relatórios", subtítulo "De onde vêm os leads e quantos viram venda.", um link no topo à direita
"QR codes →" para `/app/relatorios/qr-codes`, e `<RelatoriosClient />`.

- [ ] **Step 2: Período e hook**

`lib/relatorios/periodo.ts` + teste (hoje no fuso, 7 dias = hoje e os 6 anteriores). Hook:

```ts
"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { GrupoDeOrigem, GrupoDoRelatorio, Totais } from "@/lib/relatorios/origens";

export interface RelatorioDeOrigens {
  grupos: GrupoDoRelatorio[];
  total: Totais;
  serie: Array<{ dia: string } & Record<GrupoDeOrigem, number>>;
}

export function useRelatorioDeOrigens(p: { de: string; ate: string; fuso: string }) {
  return useQuery({
    queryKey: ["relatorios", "origens", p],
    queryFn: async () => {
      const qs = new URLSearchParams(p);
      const r = await apiClient.get<{ data: RelatorioDeOrigens }>(`/api/v1/relatorios/origens?${qs.toString()}`);
      return r.data;
    },
    staleTime: 60_000,
  });
}
```

- [ ] **Step 3: Componentes**

- `FiltroDePeriodo` — botões em pílula "7 dias" · "30 dias" (padrão) · "90 dias" · "Personalizado" (abre dois
  `<Input type="date">` "De"/"Até"); `aria-pressed` no ativo; fuso = `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- `ResumoDoPeriodo` — 4 blocos: **Leads**, **Vendas** (ganhos), **Conversão** (`—` quando `null`, com `title`
  "Ganhos ÷ (ganhos + perdidos). Aparece quando algum negócio fechou."), **Valor ganho** (BRL com centavos,
  `Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"})`). `tabular-nums`.
- `TabelaDeOrigens` — `components/ui/table`; uma linha por grupo com botão de expandir (`CaretRight`/`CaretDown`,
  `aria-expanded`), e as linhas de detalhe recuadas. Colunas: Origem · Leads · Abertos · Vendas · Perdidos ·
  Conversão · Valor ganho. Linha final "Total". Sem dados: "Nenhum lead neste período."
- `GraficoPorDia` — recharts `ResponsiveContainer` + `BarChart` empilhado (`stackId="a"`), uma `Bar` por grupo que
  apareceu no período, cores pelos tokens do tema (veja como `components/ai/UsageChart.tsx` e
  `app/globals.css` definem cores de gráfico; use `var(--chart-1)`…`var(--chart-5)` se existirem — `grep -n "chart-" app/globals.css`),
  `XAxis` com `dd/MM`, tooltip com os nomes dos grupos via `t()`. Altura 240. Sem dados: o mesmo texto vazio.
- `RelatoriosClient` — estado do período (padrão 30 dias), `useRelatorioDeOrigens`, esqueleto (`components/ui/skeleton`)
  enquanto carrega, erro com mensagem e botão "Tentar de novo".

- [ ] **Step 4: i18n**

Acrescente em `lib/i18n/dicionario.ts` (bloco `// ─── Relatórios e QR codes ───`) TODA string nova de `t()` das
Tasks 8 e 9 com `es`. Rode `pnpm exec vitest run tests/unit/i18n-espanhol-cobre-a-tela.test.ts` — ele lista o que
faltar.

- [ ] **Step 5: Teste de tela**

`tests/unit/relatorios-tela.test.tsx`: mocke `@/lib/api/client` com um payload de dois grupos (qr com 2 detalhes,
whatsapp) e envolva em `QueryClientProvider`. Casos: os 4 números aparecem formatados (`R$ 1.500,00`); conversão
`null` mostra `—`; clicar no grupo "QR codes" mostra os dois nomes; trocar para "7 dias" refaz a chamada com `de`
diferente (mock chamado de novo); estado vazio mostra "Nenhum lead neste período.". Mocke `recharts`
`ResponsiveContainer` para renderizar filhos com largura fixa (jsdom não mede).

- [ ] **Step 6: Rodar** — `pnpm exec vitest run tests/unit/relatorios-tela.test.tsx lib/relatorios tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/tailwind-tokens.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add app/app/relatorios hooks/relatorios lib/relatorios lib/i18n tests/unit/relatorios-tela.test.tsx
git commit -m "feat(relatorios): tela de origens com período, resumo, tabela e gráfico por dia

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Tela de QR codes

**Files:**
- Create: `hooks/qr-codes/useQrCodes.ts`, `app/app/relatorios/qr-codes/page.tsx`,
  `app/app/relatorios/qr-codes/_components/QrCodesClient.tsx`, `.../CartaoDoQr.tsx`, `.../DialogoDoQr.tsx`,
  `.../ImagemDoQr.tsx`, `lib/qr-codes/avisos.ts` (+ `.test.ts`)
- Modify: `lib/i18n/dicionario.ts`
- Test: `tests/unit/qr-codes-tela.test.tsx`

**Interfaces:**
- Consumes: `GET/POST/PATCH /api/v1/qr-codes` (Task 5), `GET /api/v1/relatorios/qr-codes` (Task 6),
  `linkPublicoDoQr`, `mensagemComCodigo` (Task 2), lib `qrcode` (`import QRCode from "qrcode"`).
- Produces: `useQrCodes()`, `useFunilDosQrCodes(periodo)`, `useCriarQrCode()`, `useEditarQrCode()`;
  `avisosDoQr({ leituras, conversas, temNumero }) → Array<"sem_numero" | "leituras_sem_conversa">`
  (`leituras_sem_conversa` quando `leituras >= 10 && conversas === 0`).

- [ ] **Step 1: Avisos (puro) + teste** — `lib/qr-codes/avisos.ts` com a regra acima; teste com 9/0 (sem aviso),
  10/0 (aviso), 10/1 (sem aviso), sem número (aviso).

- [ ] **Step 2: Hooks** — molde de `hooks/webhooks/useAutomationRules.ts` (`useQuery` + `useMutation` com
  `onError: showApiError` e `invalidateQueries({ queryKey: ["qr-codes"] })`). O funil usa a chave
  `["relatorios","qr-codes",periodo]`.

- [ ] **Step 3: `ImagemDoQr`**

```tsx
"use client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** O QR desenhado no navegador (nada sai para serviço externo). Margem 2 e correção M: lê bem impresso pequeno. */
export function ImagemDoQr({ link, tamanho = 160, rotulo }: { link: string; tamanho?: number; rotulo: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    QRCode.toString(link, { type: "svg", margin: 2, errorCorrectionLevel: "M" }).then((s) => {
      if (vivo) setSvg(s);
    });
    return () => {
      vivo = false;
    };
  }, [link]);
  return (
    <div
      role="img"
      aria-label={rotulo}
      className="shrink-0 rounded-md bg-white p-1"
      style={{ width: tamanho, height: tamanho }}
      // O SVG vem da própria lib a partir de um link nosso — não há HTML de usuário aqui.
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
```

O fundo branco é deliberado nos DOIS temas (QR precisa de contraste claro/escuro real para ser lido). Confira se
`bg-white` passa no guarda de tokens; se não passar, use o token de superfície clara que o guarda aceita e declare o
motivo no comentário.

Downloads (no `CartaoDoQr`): **PNG** via `QRCode.toDataURL(link, { width: 1024, margin: 2, errorCorrectionLevel: "M" })`
e um `<a download="qr-<codigo>.png">` criado e clicado; **SVG** via `QRCode.toString(..., { type: "svg" })` →
`Blob` → `URL.createObjectURL` → `<a download="qr-<codigo>.svg">` (revogar a URL depois).

- [ ] **Step 4: `CartaoDoQr`** — mostra `ImagemDoQr` (160px), nome, código, link público por extenso
  (`linkPublicoDoQr(window.location.origin, codigo)`) com botão **Copiar link** (`navigator.clipboard.writeText` +
  toast "Link copiado"), a mensagem final (`mensagemComCodigo`), o número (nome do canal + telefone), o funil do
  período em 4 números com a taxa entre eles ("Leituras 120 → Conversas 30 (25%) → Leads 22 (73%) → Vendas 5 (23%)"
  — taxa `—` quando o anterior é 0), os avisos (`Warning` + texto: "10 leituras ou mais e nenhuma conversa. O cliente
  pode estar apagando o código da mensagem, ou o número está errado." / "Este QR não tem número de WhatsApp ligado —
  quem ler vê uma página de aviso."), e ações **Baixar PNG**, **Baixar SVG**, **Editar**, **Arquivar** (confirmação
  com `components/ui/alert-dialog`: "Quem ler este QR verá que ele não está mais ativo. Os números ficam guardados.")
  ou **Reativar** quando arquivado (cartão com opacidade reduzida e selo "Arquivado").

- [ ] **Step 5: `DialogoDoQr`** (criar e editar) — `components/ui/dialog`, campos: **Nome** ("Cartaz da recepção"),
  **Número de WhatsApp** (`components/ui/select` com os canais que TÊM telefone; o desconectado aparece com
  "(desconectado)"; sem nenhum canal com telefone: o diálogo mostra "Conecte um número de WhatsApp antes de criar um
  QR code." com link para `/app/connections`, e o botão salvar fica desabilitado), **Mensagem** (`textarea`, padrão
  "Olá! Gostaria de saber mais.", contador 0/300), e a **Prévia** "O cliente vai enviar: Olá! Gostaria de saber mais.
  #XXXXXX" (na criação o código ainda não existe: mostrar `#······` e a frase "o código é criado ao salvar"). Na
  edição, aviso: "Mudar a mensagem vale para as próximas leituras. O código não muda — ele está impresso."

- [ ] **Step 6: `QrCodesClient` + página** — página servidor com o mesmo gate da Task 8, título "QR codes",
  subtítulo "Para cartaz, panfleto, cartão e vitrine. Cada leitura, conversa e venda é contada.", link
  "← Relatórios". Cliente: botão **Novo QR code**, filtro de período (reusar `FiltroDePeriodo`), lista de cartões
  (ativos primeiro, depois arquivados sob o título "Arquivados"), estado vazio com explicação curta do que acontece
  ("1. Crie o QR e imprima. 2. O cliente lê e o WhatsApp abre com a mensagem pronta. 3. A conversa e o lead aparecem
  aqui e no relatório.") e o botão de criar.

- [ ] **Step 7: Teste de tela** — `tests/unit/qr-codes-tela.test.tsx`: mocke `qrcode` (`toString` → `"<svg></svg>"`,
  `toDataURL` → `"data:image/png;base64,AA"`), `@/lib/api/client` e `navigator.clipboard`. Casos: lista mostra nome,
  link `http://localhost:3000/q/<codigo>` (ou o `location.origin` do jsdom) e funil com taxas; aviso
  "nenhuma conversa" aparece com 10/0; criar envia `{ nome, mensagem, channel_session_id }` e fecha o diálogo; sem
  canal com telefone o salvar fica desabilitado e o texto de conectar aparece; arquivar pede confirmação e envia
  `{ arquivado: true }`; copiar link chama `clipboard.writeText` com o link.

- [ ] **Step 8: Rodar** — `pnpm exec vitest run tests/unit/qr-codes-tela.test.tsx lib/qr-codes tests/unit/navegacao-completude.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/tailwind-tokens.test.ts` → PASS.

- [ ] **Step 9: Commit**

```bash
git add app/app/relatorios/qr-codes hooks/qr-codes lib/qr-codes lib/i18n tests/unit/qr-codes-tela.test.tsx
git commit -m "feat(qr): tela de QR codes — criar, baixar, copiar, arquivar e ver o funil

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Card do funil diz "QR: <nome>"

**Files:**
- Modify: `lib/kanban/prazo-e-origem.ts`, `lib/kanban/prazo-e-origem.test.ts`, `components/kanban/KanbanCard.tsx`

- [ ] **Step 1: Teste** — em `prazo-e-origem.test.ts`:
  `origemDoLead("qr_code", t, { qr_code_nome: "Cartaz da recepção" })` → `{ icone: "qr", rotulo: "QR: Cartaz da recepção" }`;
  sem nome → `{ icone: "qr", rotulo: "QR code" }`; `"meta_ads"` → `{ icone: "anuncio", rotulo: "Anúncio" }` (com
  `ad_title` no metadata: `"Anúncio: <título>"`). Os casos antigos continuam passando.

- [ ] **Step 2: Implementar** — `IconeDaOrigem` ganha `"qr"` e `"anuncio"`; assinatura
  `origemDoLead(source, t, metadata?: Record<string, unknown> | null)`; strings novas no dicionário
  (`"QR code"`, `"QR:"`, `"Anúncio"`, `"Anúncio:"`). Em `KanbanCard.tsx`: `origemDoLead(lead.source, t, lead.source_metadata)`
  e `ICONE_DA_ORIGEM` com `qr: QrCode` e `anuncio: Megaphone` (verifique se `Megaphone` é exportado em
  `lib/ui/icons.ts`; se não for, acrescente a reexportação lá, do mesmo pacote de ícones).

- [ ] **Step 3: Rodar** — `pnpm exec vitest run lib/kanban tests/unit/funil-card-mais-util.test.tsx` → PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/kanban components/kanban lib/i18n lib/ui
git commit -m "feat(funil): o card diz de qual QR (ou anúncio) o lead veio

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: A jornada no navegador (e2e)

**Files:**
- Create: `tests/e2e/relatorios-e-qr-codes.spec.ts`
- Modify: `.github/workflows/e2e.yml` (`SPECS_PARTE_1`, logo depois de `funil-card-mais-util.spec.ts`)

Molde: `tests/e2e/funil-card-mais-util.spec.ts` (login, seed por service role, `destinoEhLocal`, limpeza) e
`tests/e2e/conversa-vira-lead.spec.ts` (`mandarMensagem` via `POST /api/v1/webhooks/waha/<token>` com
`creds.nascimento`).

- [ ] **Step 1: Seed** — `beforeAll`: guarde o `phone_number` atual da sessão `creds.nascimento` e grave um de teste
  (`5500000000099`) — restaure no `afterAll`. Telefone do cliente simulado: `55000000NNNN` com sufixo do pid.
  Limpeza: `qr_code_conversas`/`qr_code_leituras`/`qr_codes` cujo `nome` começa com `E2E QR ` e os leads/contatos do
  telefone simulado.

- [ ] **Step 2: Casos (serial)**
  1. **Criar pela tela**: gestor abre `/app/relatorios/qr-codes`, clica **Novo QR code**, preenche nome
     `E2E QR <sufixo>`, escolhe o número, mantém a mensagem padrão, salva; o cartão aparece com o QR desenhado
     (`[role=img]` com `svg`), o link `/q/XXXXXX` e a mensagem final com `#XXXXXX`. Guarde o código lido do cartão.
  2. **Ler**: `page.request.get("/q/<codigo>", { maxRedirects: 0, headers: { "user-agent": IPHONE } })` → 302 e
     `location` começando com `https://wa.me/5500000000099?text=` e contendo `%23<codigo>`; repita com
     `user-agent: "WhatsApp/2.23"` → 302. No banco: **1** leitura (a do robô não conta).
  3. **Mensagem chega**: `mandarMensagem(page, "Olá! Gostaria de saber mais. #<codigo>", id)` → 200; no banco
     (poll até 20 s) existe `qr_code_conversas` desse QR com `lead_id` preenchido, e o lead tem `source = 'qr_code'` e
     `source_metadata.qr_code_nome = "E2E QR <sufixo>"`.
  4. **Funil na tela**: recarregar a tela de QR codes → o cartão mostra Leituras 1 · Conversas 1 · Leads 1.
  5. **Relatório**: `/app/relatorios` (30 dias) → a linha "QR codes" existe; expandir mostra `E2E QR <sufixo>` com
     1 lead; o resumo mostra Leads ≥ 1.
  6. **Card do funil**: no quadro do funil de entrada, o card do lead mostra a origem "QR: E2E QR <sufixo>".
  7. **Arquivar**: arquivar pelo cartão (confirmação) → `GET /q/<codigo>` devolve 410 com "não está mais ativo".
  8. **Papel**: logado como `agent`, `/app/relatorios` redireciona para `/app/inbox` e a barra NÃO tem a aba
     "Relatórios"; como `manager`, a barra tem 6 abas e nenhuma rolagem lateral em 1280 px (meça
     `document.documentElement.scrollWidth <= clientWidth`).
  9. **Celular (390×844)**: as duas telas sem rolagem lateral, com captura de cada uma.
  Capturas também do relatório no tema claro e da tela de QR codes no escuro (tema por
  `localStorage.setItem("elevcrm-theme", t)`). As imagens ficam em `test-results/` (artefato de build, fora do
  versionamento): nenhum documento as cita.

- [ ] **Step 3: Rodar local** (dev server do worktree na porta 3203 com WhatsApp desligado — ver os scripts
  `dev-wt.sh`/`e2e-wt.sh` do scratchpad da sessão anterior, ou subir `pnpm exec next dev -p 3203` com `.env.e2e`
  carregado e `WAHA_API_BASE_URL=http://127.0.0.1:3997`). Expected: todos passam. Abra as capturas e confira a olho
  E por medida (nada cortado, texto legível nos dois temas).

- [ ] **Step 4: Registrar no CI** — acrescente `relatorios-e-qr-codes.spec.ts` em `SPECS_PARTE_1` e rode
  `pnpm exec vitest run tests/unit/e2e-cobertura-completa.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/relatorios-e-qr-codes.spec.ts .github/workflows/e2e.yml
git commit -m "test(e2e): QR criado, lido, conversa vira lead com origem e aparece no relatório

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Documentos, portão e PR

- [ ] **Step 1: Changelog** — `.changes/relatorios-e-qr-codes.md`:

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: Relatórios de origem dos leads e QR codes que medem cartaz e panfleto
---
Uma aba nova, **Relatórios**, só para gestor e administrador, mostra de onde os leads vêm no período escolhido
(7, 30, 90 dias ou datas): QR codes, anúncios, formulários, WhatsApp direto, criados à mão, importados. Para cada
origem: quantos leads, quantos ganhos e perdidos, a conversão e o valor ganho, e um gráfico de leads por dia.

Em **Relatórios › QR codes** dá para criar um QR para cartaz, panfleto, cartão ou vitrine, escolher o número de
WhatsApp e a mensagem que o cliente vai mandar, e baixar a imagem (PNG ou SVG). Quem lê o QR abre o WhatsApp com a
mensagem pronta e um código curto no fim (ex.: `#R7K2QH`). O sistema conta as leituras, as conversas que chegaram
com o código, os leads e as vendas — e o lead novo já aparece no funil com a origem "QR: <nome>".

Limites: se o cliente apagar o código antes de enviar, aquela conversa não é atribuída ao QR. A leitura conta
aparelhos, não pessoas, e não guarda IP nem dado de quem leu.

A atualização aplica sozinha a migração 0220 (tabelas dos QR codes e funções do relatório). Nada a fazer.
```

- [ ] **Step 2: Mapa de jornadas** — em `docs/testing/user-journey-map.md`, acrescente a jornada "Medir origem com
  QR code" com os casos do e2e e o arquivo da spec.

- [ ] **Step 3: Arquitetura** — se `docs/architecture/` tiver mapa JSON das peças (`ls docs/architecture`), acrescente
  `qr_codes` com as arestas: entrada `/q/[codigo]` → `qr_code_leituras`; `pos-entrada` → `qr_code_conversas` →
  `crm_leads`; `/app/relatorios` ← funções de relatório (≥ 2 arestas, regra do sistema vivo).

- [ ] **Step 4: Portão completo** (dev servers parados):

```bash
NODE_OPTIONS=--max-old-space-size=5120 pnpm gov:verify > /tmp/gate.log 2>&1; echo "rc=$?"
grep -aE "Test Files|Tests " /tmp/gate.log | tail -2
pnpm test:shell > /tmp/shell.log 2>&1; echo "rc=$?"
pnpm test:db > /tmp/db.log 2>&1; echo "rc=$?"; grep -aE "Test Files|Tests " /tmp/db.log | tail -2
```

Expected: os três `rc=0`. Compare o rodapé com o `grep FAIL` (CLAUDE.md, seção Testes).

- [ ] **Step 5: Mutações** — para cada uma, aplicar, rodar os testes da área, ver FALHAR e reverter (`git checkout -- <arquivo>`):
  1. `pos-entrada.ts`: chamar `reconhecerQr` DEPOIS de `abrirDemanda`.
  2. `reconhecer.ts`: remover a guarda de grupo.
  3. `reconhecer.ts`: buscar o QR sem `.eq("organization_id", ...)`.
  4. `nascimento-do-lead.ts`: inverter a precedência (anúncio antes de `dados.origem`).
  5. `app/q/[codigo]/route.ts`: contar leitura de robô.
  6. `app/q/[codigo]/route.ts`: devolver 404 em vez de redirecionar quando o limitador nega.
  7. `codigo.ts`: aceitar byte ≥ 248.
  8. `origens.ts`: conversão `ganhos / leads` em vez de `ganhos / (ganhos + perdidos)`.
  9. `origens.ts`: `serieDiaria` sem preencher dias vazios.
  10. migration: tirar `fn_role_at_least(... 'manager')` da policy de leitura de `qr_codes` (rodar o invariante).
  11. registry: tirar `minRole: "manager"` de `/app/relatorios`.
  12. `avisos.ts`: limiar 1 em vez de 10.
  Sobreviveu alguma? Reforce o teste até ela morrer, e anote no PR.

- [ ] **Step 6: Commit, push e PR**

```bash
git add .changes docs
git commit -m "docs: changelog e mapa de jornadas dos relatórios e QR codes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push fork elev/relatorios-e-qr-codes
gh pr create --repo Elevstudio-Dev/ElevCRM --base main --head elev/relatorios-e-qr-codes \
  --title "Relatórios de origem e QR codes rastreáveis" --body-file <corpo.md>
```

O corpo do PR segue o molde dos PRs #15/#17: O que muda · decisões do dono · Como foi provado (unit, invariantes,
mutações, e2e, portão com números) · **Não provado** (leitura com celular real e câmera; mensagem real de WhatsApp —
o e2e usa o webhook simulado; telas logadas na VPS; impressão física do QR) · termina com
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 7: CI** — acompanhar até todos os checks verdes (`gh pr checks <N> --repo Elevstudio-Dev/ElevCRM --watch`).
  Falha de rede no build de imagem (fonte do Google) é flake conhecido: `gh run rerun <run> --failed`. Qualquer outra
  falha: reproduzir local, corrigir na causa, novo commit.

- [ ] **Step 8: Parar e reportar ao Carlos.** NÃO mesclar, NÃO cortar release, NÃO tocar a VPS sem o OK dele.

---

## Self-review (feito ao escrever)

- **Cobertura do spec:** medição leitura+conversa (T3, T4) · frase + código (T2, T3, T9) · leads por origem, até a
  venda, funil do QR, evolução (T1, T6, T8, T9) · aba gestor+ e sexta aba (T7) · cliente existente: conversa conta,
  origem do lead aberto não muda (T4 — `ja_existe` intacto) · limites declarados no changelog (T12) · card "QR: nome"
  (T10) · sistema vivo: auditoria (T5), avisos (T9), porta (T7), mapa (T12).
- **Tipos consistentes:** `QrReconhecido` (T4) usado por `origemDoQr`/`vincularLeadAoQr`; `OrigemDoNascimento`
  exportado de `nascimento-do-lead.ts` e importado como `type` em `reconhecer.ts` (sem ciclo de runtime);
  `QrCodeRow`/`CanalDoQr` (T5) consumidos pelos hooks (T9); `GrupoDoRelatorio`/`Totais` (T6) pelo hook (T8).
- **Riscos conhecidos para o executor:** o mock de builder do Supabase nos testes precisa refletir os métodos usados
  (`.not`, `.order`, `.limit`); confirmar `ok()` com status 201; confirmar `Megaphone` no mapa de ícones; a barra com
  6 abas precisa ser medida em 768/1024/1280 px (se apertar em 768, os rótulos já viram só ícone — conferir).
