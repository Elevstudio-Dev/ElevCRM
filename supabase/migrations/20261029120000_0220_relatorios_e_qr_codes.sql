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
