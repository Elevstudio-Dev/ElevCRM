-- 0223 — o relatório de origens separa os anúncios pelo CÓDIGO do anúncio, não só pelo título.
--
-- ## O pedido
--
-- "Aparecer exatamente de qual anúncio veio" e "vincular os dados dos anúncios na aba Relatórios".
--
-- ## O defeito que isto corrige
--
-- `fn_relatorio_de_origens` agrupava os anúncios pelo TÍTULO. Dois anúncios com o mesmo título viravam uma
-- linha só, e um anúncio cujo título foi trocado virava duas. O WhatsApp entrega junto do clique o CÓDIGO do
-- anúncio (`ad_raw.sourceId`, o mesmo para todo mundo que clicou nele). A função passa a devolver os dois no
-- `detalhe`, separados por `chr(31)` (separador de unidade, que não aparece em título de anúncio):
--
--     <código do anúncio> chr(31) <título>
--
-- ## O que NÃO muda
--
-- Assinatura, colunas, `security invoker`, permissões e o filtro "fora do funil" (0221) ficam como estão.
-- Linhas sem código (anúncio de outra origem, formato antigo) saem como `chr(31) || título`, e o leitor trata
-- o código vazio como "agrupe pelo título" — o comportamento de antes. Aditiva e idempotente; não toca em dado.

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
        coalesce(nullif(l.source_metadata->'ad_raw'->>'sourceId', ''), '')
        || chr(31)
        || coalesce(nullif(l.source_metadata->>'ad_title', ''), nullif(l.source_metadata->>'ad_source_id', ''), '')
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

notify pgrst, 'reload schema';
