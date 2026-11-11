-- 0225 — Meta Ads: as conversas iniciadas que a PRÓPRIA Meta informa, por dia e por anúncio.
--
-- ## O pedido
--
-- O relatório mostrava só o que o CRM sabia (contatos com a marca do anúncio). Mas a Meta conta mais: o Gerenciador
-- de Anúncios informa "conversas por mensagem iniciadas" por anúncio, inclusive de gente que clicou antes de o CRM
-- existir ou cuja mensagem chegou sem a marca do anúncio. O cliente precisa ver o número COMPLETO da Meta, ao lado
-- do que o CRM reconheceu.
--
-- ## O que entra
--
--   meta_ads_gasto_diario.conversations   conversas iniciadas, como a Meta conta (action_type
--                                         `onsite_conversion.messaging_conversation_started_7d`). Default 0: a linha
--                                         de um dia anterior a esta migration vale 0 até a próxima leitura da Meta.
--   fn_relatorio_de_anuncios              passa a devolver `conversas` (depois de `cliques`).
--
-- ## O que NÃO muda
--
-- Nenhum dado existente é apagado. `create or replace` não pode mudar as colunas de retorno de uma função, então
-- ela é recriada (drop + create) com os MESMOS grants da 0224: nenhum para anon, EXECUTE para authenticated e
-- service_role. Continua `security invoker`: a RLS da tabela vale através dela.

alter table public.meta_ads_gasto_diario
  add column if not exists conversations bigint not null default 0 check (conversations >= 0);

comment on column public.meta_ads_gasto_diario.conversations is
  'Conversas por mensagem iniciadas a partir do anúncio, como a Meta as conta (a coluna do Gerenciador de Anúncios).';

drop function if exists public.fn_relatorio_de_anuncios(uuid, timestamptz, timestamptz, text);

create function public.fn_relatorio_de_anuncios(
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
  conversas bigint,
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
      sum(g.conversations)::bigint as conversas,
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
    coalesce(g.conversas, 0),
    g.moeda
  from negocios n
  full outer join gasto g on g.ad_id = n.ad_id
$$;

revoke execute on function public.fn_relatorio_de_anuncios(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.fn_relatorio_de_anuncios(uuid, timestamptz, timestamptz, text) to authenticated, service_role;

notify pgrst, 'reload schema';
