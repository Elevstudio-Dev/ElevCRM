-- ============================================================================
-- 0221 — CONTATO "FORA DO FUNIL" (equipe, prestador, parceiro: gente que não é cliente).
--
-- Hoje toda pessoa que escreve vira lead, a IA responde a todo contato e o relatório conta todo lead. Os marcadores
-- que existiam não servem: `is_blocked` é opt-out de LGPD (bloqueia até o envio humano) e `force_human` é a IA
-- pedindo humano (a própria IA e os fluxos o ligam e desligam). E `crm_leads.status` só admite open/won/lost: não
-- existe "arquivado" — marcar o negócio como `lost` o deixaria no funil e inflaria "perdidos".
--
--  * `tipos_fora_do_funil`            — os tipos que o dono cadastra (Equipe, Contador…). Arquivar em vez de apagar.
--  * `contacts.fora_do_funil_em/_tipo_id/_por` — o marcador. Nulo = é do funil (o padrão).
--  * `crm_leads.fora_do_funil`        — ESPELHO do contato, mantido SÓ pelo banco (dois gatilhos). É o que deixa as
--                                       telas filtrarem com um `.eq(...)` e o negócio voltar inteiro ao desmarcar.
--  * as 3 funções de relatório (0220) e `fn_attendant_metrics` passam a ignorar o espelho.
-- ============================================================================

create table if not exists public.tipos_fora_do_funil (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null,
  arquivado_em timestamptz,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tipos_fora_do_funil_nome_tamanho check (char_length(btrim(nome)) between 1 and 40)
);

-- Um nome só por organização (sem diferenciar maiúscula) entre os que estão em uso.
create unique index if not exists tipos_fora_do_funil_nome_uidx
  on public.tipos_fora_do_funil (organization_id, lower(btrim(nome))) where arquivado_em is null;

drop trigger if exists trg_tipos_fora_do_funil_updated_at on public.tipos_fora_do_funil;
create trigger trg_tipos_fora_do_funil_updated_at before update on public.tipos_fora_do_funil
  for each row execute function public.fn_set_updated_at();

alter table public.tipos_fora_do_funil enable row level security;

drop policy if exists "tipos_fora_do_funil_member_read" on public.tipos_fora_do_funil;
create policy "tipos_fora_do_funil_member_read" on public.tipos_fora_do_funil
  for select using (
    public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists "tipos_fora_do_funil_manager_insert" on public.tipos_fora_do_funil;
create policy "tipos_fora_do_funil_manager_insert" on public.tipos_fora_do_funil
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'manager')
  );

drop policy if exists "tipos_fora_do_funil_manager_update" on public.tipos_fora_do_funil;
create policy "tipos_fora_do_funil_manager_update" on public.tipos_fora_do_funil
  for update using (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'manager')
  ) with check (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'manager')
  );

alter table public.contacts
  add column if not exists fora_do_funil_em timestamptz,
  add column if not exists fora_do_funil_tipo_id uuid references public.tipos_fora_do_funil(id) on delete set null,
  add column if not exists fora_do_funil_por uuid references auth.users(id) on delete set null;

-- Tipo sem marcador não faz sentido: o banco recusa, não só a API.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_fora_do_funil_tipo_coerente') then
    alter table public.contacts
      add constraint contacts_fora_do_funil_tipo_coerente
      check (fora_do_funil_tipo_id is null or fora_do_funil_em is not null);
  end if;
end $$;

create index if not exists contacts_fora_do_funil_idx
  on public.contacts (organization_id) where fora_do_funil_em is not null;

alter table public.crm_leads
  add column if not exists fora_do_funil boolean not null default false;

create index if not exists crm_leads_fora_do_funil_idx
  on public.crm_leads (organization_id) where fora_do_funil;

-- Marcou/desmarcou o contato: o espelho dos negócios dele acompanha, na mesma transação.
create or replace function public.fn_espelha_fora_do_funil_nos_leads() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.fora_do_funil_em is not null) is distinct from (old.fora_do_funil_em is not null) then
    update public.crm_leads
       set fora_do_funil = (new.fora_do_funil_em is not null)
     where organization_id = new.organization_id
       and contact_id = new.id
       and fora_do_funil is distinct from (new.fora_do_funil_em is not null);
  end if;
  return new;
end $$;

revoke all on function public.fn_espelha_fora_do_funil_nos_leads() from public;
revoke execute on function public.fn_espelha_fora_do_funil_nos_leads() from anon, authenticated;

drop trigger if exists trg_contacts_espelham_fora_do_funil on public.contacts;
create trigger trg_contacts_espelham_fora_do_funil
  after update of fora_do_funil_em on public.contacts
  for each row execute function public.fn_espelha_fora_do_funil_nos_leads();

-- Negócio novo (ou que troca de contato) já nasce com o espelho certo.
create or replace function public.fn_lead_herda_fora_do_funil() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.contact_id is null then
    new.fora_do_funil := false;
  else
    select (c.fora_do_funil_em is not null) into new.fora_do_funil
      from public.contacts c
     where c.id = new.contact_id and c.organization_id = new.organization_id;
    new.fora_do_funil := coalesce(new.fora_do_funil, false);
  end if;
  return new;
end $$;

revoke all on function public.fn_lead_herda_fora_do_funil() from public;
revoke execute on function public.fn_lead_herda_fora_do_funil() from anon, authenticated;

drop trigger if exists trg_crm_leads_herdam_fora_do_funil on public.crm_leads;
create trigger trg_crm_leads_herdam_fora_do_funil
  before insert or update of contact_id on public.crm_leads
  for each row execute function public.fn_lead_herda_fora_do_funil();

-- Desempenho por atendente: o funil e os ganhos/perdidos ignoram quem está fora do funil.
create or replace function public.fn_attendant_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  lead_agg as (
    select
      owner_user_id as user_id,
      count(*) filter (where status = 'won')  as won,
      count(*) filter (where status = 'lost') as lost
    from public.crm_leads
    where organization_id = p_org
      and status in ('won', 'lost')
      and not fora_do_funil
      and closed_at >= p_from and closed_at < p_to
      and owner_user_id is not null
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  conv_agg as (
    select
      assigned_to_user_id as user_id,
      count(*) as conversations_handled
    from public.conversations
    where organization_id = p_org
      and assigned_to_user_id is not null
      and assigned_at >= p_from and assigned_at < p_to
      and (p_owner is null or assigned_to_user_id = p_owner)
    group by assigned_to_user_id
  ),
  ttfr as (
    select
      c.assigned_to_user_id as user_id,
      avg(extract(epoch from (fr.first_human_out - fr.first_in))) as avg_first_response_seconds
    from public.conversations c
    cross join lateral (
      select
        min(m.sent_at) filter (where m.direction = 'inbound') as first_in,
        min(m.sent_at) filter (
          where m.direction = 'outbound' and m.sent_by_user_id is not null
        ) as first_human_out
      from public.messages m
      where m.conversation_id = c.id
    ) fr
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and fr.first_in is not null
      and fr.first_human_out is not null
      and fr.first_human_out > fr.first_in
      and fr.first_human_out >= p_from and fr.first_human_out < p_to
    group by c.assigned_to_user_id
  ),
  attendant_ids as (
    select user_id from lead_agg
    union select user_id from conv_agg
    union select user_id from ttfr
  )
  select jsonb_build_object(
    'funnel', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'stage_id', s.id,
          'stage_name', s.name,
          'position', s.position,
          'count', coalesce(l.cnt, 0)
        ) order by s.position, s.name
      )
      from public.crm_stages s
      left join (
        select stage_id, count(*) as cnt
        from public.crm_leads
        where organization_id = p_org
          and status = 'open'
          and not fora_do_funil
          and (p_owner is null or owner_user_id = p_owner)
        group by stage_id
      ) l on l.stage_id = s.id
      where s.organization_id = p_org
        and s.is_archived = false
    ), '[]'::jsonb),
    'attendants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', a.user_id,
          'won', coalesce(la.won, 0),
          'lost', coalesce(la.lost, 0),
          'conversations_handled', coalesce(ca.conversations_handled, 0),
          'avg_first_response_seconds', tf.avg_first_response_seconds
        ) order by coalesce(la.won, 0) desc, a.user_id
      )
      from attendant_ids a
      left join lead_agg la on la.user_id = a.user_id
      left join conv_agg ca on ca.user_id = a.user_id
      left join ttfr tf on tf.user_id = a.user_id
    ), '[]'::jsonb)
  );
$$;

-- Relatórios de origem e do QR (0220): quem está fora do funil não conta.
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
    and not l.fora_do_funil
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
    and not l.fora_do_funil
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
      where l.organization_id = p_org and l.source = 'qr_code' and not l.fora_do_funil
        and l.source_metadata->>'qr_code_id' = q.id::text
        and l.created_at >= p_de and l.created_at < p_ate) as leads,
    (select count(*) from public.crm_leads l
      where l.organization_id = p_org and l.source = 'qr_code' and not l.fora_do_funil
        and l.source_metadata->>'qr_code_id' = q.id::text
        and l.created_at >= p_de and l.created_at < p_ate and l.status = 'won') as ganhos,
    (select coalesce(sum(l.value_cents), 0)::bigint from public.crm_leads l
      where l.organization_id = p_org and l.source = 'qr_code' and not l.fora_do_funil
        and l.source_metadata->>'qr_code_id' = q.id::text
        and l.created_at >= p_de and l.created_at < p_ate and l.status = 'won'
        and coalesce(l.currency, 'BRL') = 'BRL') as valor_ganho_cents
  from public.qr_codes q
  where q.organization_id = p_org
$$;


notify pgrst, 'reload schema';
