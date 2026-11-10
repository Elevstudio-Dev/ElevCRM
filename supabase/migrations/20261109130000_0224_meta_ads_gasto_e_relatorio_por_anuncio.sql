-- 0224 — Meta Ads: a conta de anúncios da organização, o gasto por anúncio e o relatório por anúncio.
--
-- ## O pedido
--
-- "Vincular a Meta": trazer o nome da campanha, do conjunto e do anúncio e quanto foi gasto, para o relatório
-- mostrar custo por contato, custo por venda e retorno. Cada organização usa a SUA conta de anúncios.
--
-- ## O que entra
--
--   meta_ads_conexoes      a conta de anúncios e a chave de leitura (cifrada) de cada organização. Uma por org.
--   meta_ads_gasto_diario  o que a Meta informou por dia e por anúncio: nomes, gasto, impressões, cliques.
--   fn_relatorio_de_anuncios  junta o gasto aos negócios que vieram de cada anúncio, pelo CÓDIGO do anúncio.
--
-- ## Por que a tabela da chave tem RLS ligada e ZERO policies
--
-- A chave é de leitura (`ads_read`), mas ainda assim dá acesso aos números de investimento da empresa. A anon key
-- vai para o navegador; uma tabela "protegida por policy" depende de a policy estar certa, e uma tabela com RLS
-- ligada, sem policy e com os grants de `anon`/`authenticated` revogados não é servida de jeito nenhum. Só o
-- `service_role`, que vive no servidor, a alcança — mesmo desenho de `platform_google_oauth` (0201). A tela recebe
-- apenas "conectada" e a hora da última atualização; a chave nunca volta ao navegador. A cifra é a que já existe
-- (`fn_encrypt_oauth`/`fn_decrypt_oauth`, 0041): nenhuma função nova em `public`, nenhuma superfície
-- `security definer` nova.
--
-- ## O gasto é legível pelo gestor da própria organização
--
-- `meta_ads_gasto_diario` não guarda segredo, e a função de relatório é `security invoker` (como as da 0220): a
-- RLS vale ATRAVÉS dela. SELECT para gestor+ da organização (ou administrador da plataforma); escrita só pelo
-- `service_role` (quem grava é a sincronização).
--
-- ## O que NÃO muda
--
-- Nada em dado existente. Aditiva e idempotente: `if not exists`, `drop policy if exists` e `create or replace`.

create table if not exists public.meta_ads_conexoes (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  ad_account_id text not null check (ad_account_id ~ '^[0-9]{5,20}$'),
  account_name text,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  token_encrypted bytea not null,
  status text not null default 'conectada' check (status in ('conectada', 'token_invalido', 'erro')),
  last_synced_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

comment on table public.meta_ads_conexoes is
  'A conta de anúncios da Meta de cada organização. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated. A chave nunca volta ao navegador; a tela recebe só o estado.';
comment on column public.meta_ads_conexoes.token_encrypted is
  'Chave de leitura (ads_read) cifrada por fn_encrypt_oauth. Nunca gravar em claro: sem a chave mestra o save recusa.';

alter table public.meta_ads_conexoes enable row level security;
revoke all on public.meta_ads_conexoes from anon, authenticated;
grant select, insert, update, delete on public.meta_ads_conexoes to service_role;

create table if not exists public.meta_ads_gasto_diario (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  dia date not null,
  ad_id text not null check (ad_id ~ '^[0-9]{5,25}$'),
  ad_name text,
  adset_id text,
  adset_name text,
  campaign_id text,
  campaign_name text,
  spend_cents bigint not null check (spend_cents >= 0),
  impressions bigint not null default 0 check (impressions >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz not null default now(),
  primary key (organization_id, dia, ad_id)
);

comment on table public.meta_ads_gasto_diario is
  'O que a Meta informou por dia e por anúncio. spend_cents está na MOEDA DA CONTA (coluna currency), não necessariamente em reais.';

create index if not exists idx_meta_ads_gasto_org_dia on public.meta_ads_gasto_diario (organization_id, dia);

alter table public.meta_ads_gasto_diario enable row level security;
revoke all on public.meta_ads_gasto_diario from anon, authenticated;
grant select on public.meta_ads_gasto_diario to authenticated;
grant select, insert, update, delete on public.meta_ads_gasto_diario to service_role;

drop policy if exists "meta_ads_gasto_manager_read" on public.meta_ads_gasto_diario;
create policy "meta_ads_gasto_manager_read" on public.meta_ads_gasto_diario
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- O relatório por anúncio: negócios que vieram do anúncio (pelo código que o WhatsApp entrega no clique) + o gasto
-- que a Meta informou para o mesmo código. FULL JOIN: anúncio que gastou e não trouxe ninguém aparece (é o que mais
-- interessa ver), e negócio de anúncio sem gasto sincronizado também. Negócios sem código ficam numa linha só, com
-- `ad_id` nulo. `dia` é o dia no fuso da conta de anúncios, comparado com o período no fuso pedido.
create or replace function public.fn_relatorio_de_anuncios(
  p_org uuid, p_de timestamptz, p_ate timestamptz, p_fuso text default 'America/Sao_Paulo'
)
returns table (
  ad_id text,
  titulo text,
  campanha text,
  conjunto text,
  anuncio text,
  leads bigint,
  abertos bigint,
  ganhos bigint,
  perdidos bigint,
  valor_ganho_cents bigint,
  gasto_cents bigint,
  impressoes bigint,
  cliques bigint,
  moeda text
)
language sql
stable
security invoker
set search_path = public
as $$
  with negocios as (
    select
      nullif(l.source_metadata->'ad_raw'->>'sourceId', '') as ad_id,
      max(nullif(l.source_metadata->>'ad_title', '')) as titulo,
      count(*) as leads,
      count(*) filter (where l.status = 'open') as abertos,
      count(*) filter (where l.status = 'won') as ganhos,
      count(*) filter (where l.status = 'lost') as perdidos,
      coalesce(sum(l.value_cents) filter (where l.status = 'won' and coalesce(l.currency, 'BRL') = 'BRL'), 0)::bigint
        as valor
    from public.crm_leads l
    where l.organization_id = p_org
      and l.source = 'meta_ads'
      and l.created_at >= p_de
      and l.created_at < p_ate
      and l.status in ('open', 'won', 'lost')
      and not l.fora_do_funil
    group by 1
  ),
  gasto as (
    select
      g.ad_id,
      (array_agg(g.campaign_name order by g.dia desc))[1] as campanha,
      (array_agg(g.adset_name order by g.dia desc))[1] as conjunto,
      (array_agg(g.ad_name order by g.dia desc))[1] as anuncio,
      sum(g.spend_cents)::bigint as gasto,
      sum(g.impressions)::bigint as impressoes,
      sum(g.clicks)::bigint as cliques,
      max(g.currency) as moeda
    from public.meta_ads_gasto_diario g
    where g.organization_id = p_org
      and g.dia >= (p_de at time zone p_fuso)::date
      and g.dia <= ((p_ate - interval '1 microsecond') at time zone p_fuso)::date
    group by 1
  )
  select
    coalesce(n.ad_id, g.ad_id),
    coalesce(n.titulo, g.anuncio),
    g.campanha,
    g.conjunto,
    g.anuncio,
    coalesce(n.leads, 0),
    coalesce(n.abertos, 0),
    coalesce(n.ganhos, 0),
    coalesce(n.perdidos, 0),
    coalesce(n.valor, 0),
    coalesce(g.gasto, 0),
    coalesce(g.impressoes, 0),
    coalesce(g.cliques, 0),
    g.moeda
  from negocios n
  full outer join gasto g on g.ad_id = n.ad_id
$$;

revoke execute on function public.fn_relatorio_de_anuncios(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.fn_relatorio_de_anuncios(uuid, timestamptz, timestamptz, text) to authenticated, service_role;

notify pgrst, 'reload schema';
