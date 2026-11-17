-- ============================================================================
-- 0228 — O RELATO DA SECRETARIA: a agenda que vem por mensagem.
--
-- A agenda real da clínica vive no CRM da franquia, que ainda não integra com o nosso. A ponte é a secretaria: a IA
-- lhe pergunta como está o dia, ela responde em texto livre ("terça 14h Maria, 15h João; quarta fechado"), a IA lê,
-- devolve um resumo para ela CONFERIR e só então a agenda daqui passa a refletir o que ela disse.
--
--  * `agenda_relatos`                       — um relato lido: o texto bruto, o que a IA entendeu (jsonb), a janela de
--                                             dias que ele cobre e o estado (lido → conferido | corrigido |
--                                             descartado). É a trilha de auditoria e o que permite refazer a leitura.
--  * `calendar_appointments.origem_relato_id` — marca o compromisso que nasceu de um relato. Quem sincroniza só
--                                             cancela e recria o que ELE criou: um compromisso marcado à mão ou pela
--                                             IA de vendas nunca é tocado pelo relato.
--
-- O relato tem nome de paciente: lê quem é atendente ou mais. Só o backend (service role) grava.
-- Aditiva e idempotente; nenhum dado é tocado.
-- ============================================================================

create table if not exists public.agenda_relatos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- A secretaria que mandou. `set null`: apagar o contato não apaga a trilha da agenda.
  contact_id uuid references public.contacts(id) on delete set null,
  -- A mensagem recebida que originou o relato (idempotência: a mesma mensagem não vira dois relatos).
  message_id uuid references public.messages(id) on delete set null,
  texto text not null,
  -- O que a IA entendeu: { marcados: [...], dias_fechados: [...], duvidas: [...] } (validado por Zod no backend).
  lido jsonb not null,
  -- Os dias que o relato COBRE. É o que decide o que um relato novo pode cancelar: só o que está dentro da janela.
  janela_de date not null,
  janela_ate date not null,
  estado text not null default 'lido',
  conferido_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agenda_relatos_estado_check check (estado in ('lido', 'conferido', 'corrigido', 'descartado')),
  constraint agenda_relatos_janela_valida check (janela_ate >= janela_de),
  -- Conferido SEM carimbo faria a agenda parecer fresca para sempre.
  constraint agenda_relatos_conferido_coerente check (estado <> 'conferido' or conferido_em is not null)
);

create index if not exists agenda_relatos_org_criado_idx
  on public.agenda_relatos (organization_id, created_at desc);
create index if not exists agenda_relatos_org_conferido_idx
  on public.agenda_relatos (organization_id, conferido_em desc) where estado = 'conferido';
-- A mesma mensagem não vira dois relatos (a captura de 23505 no INSERT é o par disto no código).
create unique index if not exists agenda_relatos_mensagem_key
  on public.agenda_relatos (organization_id, message_id) where message_id is not null;

drop trigger if exists trg_agenda_relatos_updated_at on public.agenda_relatos;
create trigger trg_agenda_relatos_updated_at before update on public.agenda_relatos
  for each row execute function public.fn_set_updated_at();

alter table public.agenda_relatos enable row level security;

drop policy if exists "agenda_relatos_agent_read" on public.agenda_relatos;
create policy "agenda_relatos_agent_read" on public.agenda_relatos
  for select to authenticated using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
    )
  );
-- Sem policy de INSERT/UPDATE/DELETE: o relato é escrito só pelo backend (service role).

alter table public.calendar_appointments
  add column if not exists origem_relato_id uuid references public.agenda_relatos(id) on delete set null;

create index if not exists calendar_appointments_origem_relato_idx
  on public.calendar_appointments (origem_relato_id) where origem_relato_id is not null;
