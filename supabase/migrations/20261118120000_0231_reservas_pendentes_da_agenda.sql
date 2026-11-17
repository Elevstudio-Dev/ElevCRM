-- ============================================================================
-- 0231 — a reserva de horário que espera a confirmação da secretaria.
--
-- Com a agenda da secretaria ligada (`settings.secretaria.ativa`), a IA não marca a consulta sozinha: a agenda de
-- verdade vive no CRM da franquia, e só a secretaria sabe se o horário ainda está livre. Quando o paciente escolhe um
-- horário, a IA cria uma RESERVA (esta tabela) e pergunta à secretaria. O horário fica SEGURADO por alguns minutos
-- (nenhum outro paciente o recebe como livre); com o "sim" dela o servidor marca de verdade e avisa o paciente; com o
-- "não", ou se ela não responde a tempo, o paciente recebe horários parecidos.
--
-- 1. `agenda_reservas_pendentes`: uma linha por pedido de reserva. Só o backend grava; lê quem é atendente ou mais.
-- 2. Dois índices únicos PARCIAIS (só valem para reserva aguardando): um horário de um dono não é segurado por dois
--    pacientes ao mesmo tempo, e um paciente não segura dois horários ao mesmo tempo. Eles é que impedem a corrida
--    entre duas conversas simultâneas: o banco recusa a segunda, o código só traduz a recusa.
--
-- Aditiva e idempotente; nenhum dado é tocado.
-- ============================================================================

create table if not exists public.agenda_reservas_pendentes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- O paciente que escolheu o horário.
  contact_id uuid not null references public.contacts(id) on delete cascade,
  event_type_id uuid not null references public.calendar_event_types(id) on delete cascade,
  -- De quem é a agenda (o profissional da avaliação).
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- O nome COMPLETO que o paciente disse: é o que a secretaria precisa para achar/anotar na agenda dela.
  nome_paciente text not null,
  notas text,
  -- aguardando_secretaria = horário segurado, pergunta feita ou por fazer; confirmada = a secretaria disse sim e o
  -- compromisso foi marcado; recusada = a secretaria disse não; expirada = ela não respondeu a tempo; cancelada = o
  -- paciente pediu outro horário (ou desistiu) antes da resposta.
  status text not null default 'aguardando_secretaria',
  -- Até quando o horário fica segurado.
  expira_em timestamptz not null,
  perguntada_em timestamptz,
  respondida_em timestamptz,
  -- O compromisso criado quando a secretaria confirma.
  appointment_id uuid references public.calendar_appointments(id) on delete set null,
  -- Carimbo de que o paciente já foi avisado do desfecho (confirmação ou alternativas): o replay de um job não
  -- manda a mesma mensagem duas vezes.
  paciente_avisado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agenda_reservas_status_check check (
    status in ('aguardando_secretaria', 'confirmada', 'recusada', 'expirada', 'cancelada')
  ),
  constraint agenda_reservas_intervalo_check check (ends_at > starts_at),
  constraint agenda_reservas_nome_check check (length(btrim(nome_paciente)) between 3 and 200)
);

create unique index if not exists agenda_reservas_horario_ativo_key
  on public.agenda_reservas_pendentes (organization_id, owner_user_id, starts_at)
  where status = 'aguardando_secretaria';
create unique index if not exists agenda_reservas_paciente_ativa_key
  on public.agenda_reservas_pendentes (organization_id, contact_id)
  where status = 'aguardando_secretaria';
create index if not exists agenda_reservas_vencimento_idx
  on public.agenda_reservas_pendentes (expira_em)
  where status = 'aguardando_secretaria';
create index if not exists agenda_reservas_org_idx
  on public.agenda_reservas_pendentes (organization_id, created_at desc);

drop trigger if exists trg_agenda_reservas_updated_at on public.agenda_reservas_pendentes;
create trigger trg_agenda_reservas_updated_at before update on public.agenda_reservas_pendentes
  for each row execute function public.fn_set_updated_at();

alter table public.agenda_reservas_pendentes enable row level security;

drop policy if exists "agenda_reservas_agent_read" on public.agenda_reservas_pendentes;
create policy "agenda_reservas_agent_read" on public.agenda_reservas_pendentes
  for select to authenticated using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
    )
  );
-- Sem policy de INSERT/UPDATE/DELETE: quem grava é o backend (service role).

notify pgrst, 'reload schema';
