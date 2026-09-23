-- 0215 — O CONTATO APONTA PARA O CADASTRO DELE NUM SISTEMA DE FORA.
--
-- ─── O que o dono pediu ─────────────────────────────────────────────────────
--
-- "Preciso integrar o Elev CRM com o Despacho Certo. Mas o Elev CRM não vai ser
-- só para despachante — então essa integração precisa ser que nem um plugin."
--
-- Na tela: ao lado de "Assumir", quem tem a integração ligada ganha um botão
-- "Cadastrar" que abre o formulário de cliente DO OUTRO SISTEMA; cadastrou
-- aqui, nasceu lá. Depois, quando uma OS é aberta lá e aquele cliente é
-- vinculado a ela, a conversa e o contato daqui ganham as tags da OS e da
-- placa.
--
-- ─── Por que uma tabela de VÍNCULO, e não uma coluna em `contacts` ──────────
--
-- `contacts.despachocerto_client_id` seria uma coluna com o nome de um produto
-- de nicho na tabela mais central de um CRM que se vende para lojas, clínicas
-- e escritórios. A segunda integração pediria a segunda coluna, e o `select *`
-- do inbox passaria a carregar cadastro de sistema que aquela organização não
-- usa.
--
-- `integration_contact_links` é a mesma ideia de `tenant_integrations`, um
-- nível abaixo: aquela diz QUE a organização tem a integração; esta diz QUEM é
-- cada pessoa do outro lado. Quem não ligou integração nenhuma não tem linha
-- aqui, e a tabela custa zero a ele.
--
-- ─── As duas unicidades, e o que cada uma impede ────────────────────────────
--
-- `(organization_id, provider, contact_id)` — um contato aponta para UM
-- cadastro por sistema. Sem ela, clicar "Cadastrar" duas vezes criaria dois
-- vínculos e a tag da OS cairia em um deles, sorteado.
--
-- `(organization_id, provider, external_id)` — e dois contatos não apontam
-- para o MESMO cadastro. Sem ela, dois números de WhatsApp do mesmo cliente
-- viram dois vínculos para o mesmo cadastro, e uma OS marcaria os dois — o
-- operador veria a mesma OS em duas conversas sem saber qual é a boa.
--
-- Aditiva e idempotente: nada aqui altera dado existente.

-- ── 1. o vocabulário de integração ganha o Despacho Certo ──────────────────
-- A lista INTEIRA reconstruída num bloco só — lição da 0129: acrescentar valor
-- a um CHECK por `add constraint` deixa duas verdades no schema quando alguém
-- aplica só uma das migrations.
alter table public.tenant_integrations
  drop constraint if exists tenant_integrations_provider_check;
alter table public.tenant_integrations
  add constraint tenant_integrations_provider_check
  check (provider in ('nuvemshop', 'vtex', 'shopify', 'despachocerto'));

-- ── 2. quem é este contato no outro sistema ────────────────────────────────
create table if not exists public.integration_contact_links (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  -- Mesmo vocabulário de `tenant_integrations`: o vínculo só existe para
  -- integração que a organização realmente ligou.
  provider          text not null,
  contact_id        uuid not null references public.contacts(id) on delete cascade,
  -- O id do cadastro LÁ. `text` e não `uuid`: sistema de fora escolhe a forma
  -- do id dele, e um dia será um que não é uuid.
  external_id       text not null,
  -- O que a tela precisa mostrar sem ir ao outro sistema a cada render: nome
  -- do cadastro, documento mascarado, a URL da ficha. Nunca segredo.
  external_metadata jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint integration_contact_links_provider_check
    check (provider in ('nuvemshop', 'vtex', 'shopify', 'despachocerto'))
);

create unique index if not exists uniq_integration_contact_links_contato
  on public.integration_contact_links (organization_id, provider, contact_id);
create unique index if not exists uniq_integration_contact_links_externo
  on public.integration_contact_links (organization_id, provider, external_id);

-- ── 3. RLS ─────────────────────────────────────────────────────────────────
-- Leitura para quem é da organização (a tela do inbox mostra o vínculo).
-- ESCRITA só por service role: quem cria o vínculo é o handler, depois de
-- falar com o outro sistema — um insert pelo cliente de sessão poderia apontar
-- o contato para um cadastro que não existe lá.
alter table public.integration_contact_links enable row level security;

drop policy if exists integration_contact_links_select on public.integration_contact_links;
create policy integration_contact_links_select on public.integration_contact_links
  for select to authenticated using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );
