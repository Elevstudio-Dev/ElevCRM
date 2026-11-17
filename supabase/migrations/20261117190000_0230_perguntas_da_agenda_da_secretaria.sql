-- ============================================================================
-- 0230 — as perguntas diárias da IA à secretaria sobre a agenda.
--
-- A IA pergunta à secretaria, em horários fixos (padrão 08:30, 14:00 e 18:15, de segunda a sexta), como está a
-- agenda. Se ela não responde em 30 minutos a IA lembra UMA vez; se continua sem responder, o administrador é
-- avisado na Central de avisos. `agenda_perguntas` guarda o que já foi perguntado, e é o que impede a mesma pergunta
-- de sair duas vezes (a chave única é organização + contato + dia + horário) quando o cron roda de novo no mesmo
-- minuto, ou duas instâncias rodam juntas.
--
-- 1. `agenda_perguntas`: uma linha por pergunta feita (ou dispensada), com os carimbos de lembrete, resposta e
--    aviso ao administrador. Só o backend grava; lê quem é atendente ou mais.
-- 2. `agent_inbox_items.kind` ganha `agenda_sem_resposta`: a secretaria não respondeu (ou nem tem conversa para
--    perguntar). A lista é reconstruída em UM bloco só, com o vocabulário completo (lição do #159).
--
-- Aditiva e idempotente; nenhum dado é tocado.
-- ============================================================================

create table if not exists public.agenda_perguntas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- A secretaria perguntada. Apagar o contato apaga o histórico de perguntas dele (é só controle do cron).
  contact_id uuid not null references public.contacts(id) on delete cascade,
  -- O dia (no fuso da agenda) e o horário da pergunta, como escritos em `settings.secretaria.perguntas`.
  dia date not null,
  horario text not null,
  -- pedida = a IA mandou (ou vai mandar) a pergunta; dispensada = a agenda acabara de ser conferida, não precisou
  -- perguntar; sem_conversa = não há conversa com ela para perguntar (o administrador foi avisado).
  estado text not null default 'pedida',
  pedida_em timestamptz not null default now(),
  lembrete_pedido_em timestamptz,
  respondida_em timestamptz,
  admin_avisado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agenda_perguntas_estado_check check (estado in ('pedida', 'dispensada', 'sem_conversa')),
  constraint agenda_perguntas_horario_check check (horario ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

-- A mesma pergunta não sai duas vezes (o INSERT ... ON CONFLICT DO NOTHING do cron é o par disto no código).
create unique index if not exists agenda_perguntas_slot_key
  on public.agenda_perguntas (organization_id, contact_id, dia, horario);
create index if not exists agenda_perguntas_org_dia_idx
  on public.agenda_perguntas (organization_id, dia desc);

drop trigger if exists trg_agenda_perguntas_updated_at on public.agenda_perguntas;
create trigger trg_agenda_perguntas_updated_at before update on public.agenda_perguntas
  for each row execute function public.fn_set_updated_at();

alter table public.agenda_perguntas enable row level security;

drop policy if exists "agenda_perguntas_agent_read" on public.agenda_perguntas;
create policy "agenda_perguntas_agent_read" on public.agenda_perguntas
  for select to authenticated using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
    )
  );
-- Sem policy de INSERT/UPDATE/DELETE: quem grava é o cron (service role).

-- ---------------------------------------------------------------------------
-- A Central de avisos aprende que a secretaria pode não responder
-- ---------------------------------------------------------------------------
-- Entra no FIM da lista, antes de 'other' (um teste procura 'midia_nao_lida' nos primeiros 2000 caracteres a
-- partir do `add constraint`: valor novo no meio empurra).

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'appointment_reminder_failed',
    'agenda_sem_resposta',
    'other'
  ));

notify pgrst, 'reload schema';
