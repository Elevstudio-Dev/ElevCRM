-- 0217 — o lembrete de consulta ganha ESTADO, e remarcar passa a rearmá-lo.
--
-- ## O buraco, medido
--
-- A 0177 criou `calendar_event_types.reminder_enabled / reminder_minutes_before /
-- reminder_template_name` e `calendar_appointments.reminder_sent_at`; a 0194 deixou o
-- lembrete DESLIGADO por padrão "até o disparador nascer". Em 2026-10-23, zero leitores
-- fora de `database.types.ts` e nenhum cron no scheduler: o produto avisava, na tela de
-- marcar, que "fulano não receberá o lembrete" — e nunca mandava lembrete a ninguém.
--
-- ## O que entra
--
-- 1. Cinco colunas em `calendar_appointments` que dizem o que aconteceu com o lembrete
--    DESTE compromisso: `reminder_state` (pending | sent | skipped | failed),
--    `reminder_detail` (o motivo curto), `reminder_attempts`, `reminder_message_id` (a
--    mensagem que saiu) e `reminder_armed_at` (quando o lembrete foi armado para o
--    horário vigente). `reminder_sent_at`, que já existia, segue sendo o carimbo.
--
-- 2. Um trigger que REARMA o lembrete quando `starts_at` muda. Remarcar é a mesma linha
--    mudando de hora (ver `alterarAgendamentoHandler`), e o Google sync também altera
--    horário: confiar que cada caminho lembre de zerar o carimbo é a classe de bug que a
--    própria 0177 descreveu ("remarcação ou reprocesso não avisarem duas vezes").
--
-- 3. `fn_lembretes_devidos(now, limite)`: os compromissos cujo momento de avisar chegou.
--    A conta `starts_at - reminder_minutes_before <= now` é de linha, não cabe num filtro
--    do PostgREST — e fazê-la no aplicativo obrigaria a trazer todo compromisso futuro.
--
-- 4. O alerta `appointment_reminder_failed` na Central de avisos: lembrete que não sai
--    não pode ser um `return` mudo do cron.
--
-- ## Por que `reminder_armed_at`
--
-- Quem marca uma consulta para daqui a 3 h com lembrete de 24 h não deve receber um
-- "lembrete" seis segundos depois de marcar. A regra é: só avisa quem estava armado ANTES
-- do momento devido. O mesmo vale para remarcar para daqui a pouco.
--
-- ## Compatibilidade
--
-- Aditiva. As linhas existentes ficam `pending` com `reminder_armed_at = now()` (o default
-- preenche); como `reminder_enabled` nasce `false` desde a 0194, nada sai até alguém ligar.
-- A lista de `agent_inbox_items.kind` é reconstruída em UM bloco só, com o vocabulário
-- completo (lição do #159: `kind-check-migration-x-baseline` exige que a última migration
-- que a reconstrói termine igual ao baseline).

-- ---------------------------------------------------------------------------
-- 1 · o estado do lembrete, por compromisso
-- ---------------------------------------------------------------------------

alter table public.calendar_appointments
  add column if not exists reminder_state text not null default 'pending';
alter table public.calendar_appointments
  add column if not exists reminder_detail text;
alter table public.calendar_appointments
  add column if not exists reminder_attempts smallint not null default 0;
alter table public.calendar_appointments
  add column if not exists reminder_message_id uuid references public.messages(id) on delete set null;
alter table public.calendar_appointments
  add column if not exists reminder_armed_at timestamptz not null default now();

-- Quem já tem carimbo (nenhum, hoje) está enviado. Antes do CHECK, para ele não recusar a linha.
update public.calendar_appointments
   set reminder_state = 'sent'
 where reminder_sent_at is not null
   and reminder_state = 'pending';

alter table public.calendar_appointments
  drop constraint if exists calendar_appointments_reminder_state_check;
alter table public.calendar_appointments
  add constraint calendar_appointments_reminder_state_check
  check (reminder_state in ('pending', 'sent', 'skipped', 'failed'));

-- Regra de negócio em constraint SEPARADA da de vocabulário (mesma convivência de
-- `calendar_appointments_status_check` com `..._cancelamento_coerente`): "enviado" e
-- "tem carimbo" são o mesmo fato, e dois campos que contam o mesmo fato divergem.
--
-- ⚠️ A FORMA é uma disjunção de conjunções e não `(a = 'sent') = (b is not null)`, e a
-- diferença não é estilo: o extrator de vocabulário (ver `agenda-vocabulario.test.ts`)
-- distingue "lista de valores" de "regra" pela ausência de AND/OR, e a forma curta lia
-- como um CHECK de um valor só na mesma coluna — duas constraints de vocabulário, e o
-- instrumento se recusa a escolher.
alter table public.calendar_appointments
  drop constraint if exists calendar_appointments_lembrete_coerente;
alter table public.calendar_appointments
  add constraint calendar_appointments_lembrete_coerente
  check (
    (reminder_state = 'sent' and reminder_sent_at is not null)
    or (reminder_state <> 'sent' and reminder_sent_at is null)
  );

-- O que o cron varre: compromisso vivo com lembrete por tratar.
create index if not exists calendar_appointments_lembrete_pendente_idx
  on public.calendar_appointments (starts_at)
  where reminder_state = 'pending' and status in ('pending', 'confirmed');

comment on column public.calendar_appointments.reminder_state is
  'pending = ainda não tratado (inclui "esperando a janela de envio"); sent = saiu; skipped = não deve sair (tarde demais, marcado dentro do prazo, contato bloqueado); failed = tentou e não conseguiu. Remarcar volta a pending.';
comment on column public.calendar_appointments.reminder_detail is
  'O motivo curto do último desfecho ou espera: late, booked_inside_horizon, blocked, no_template, no_conversation, channel_down, outside_courtesy_hours, template_slot:<chave>, send_failed:<código>.';
comment on column public.calendar_appointments.reminder_attempts is
  'Tentativas de envio já feitas para o horário vigente. Três falhas viram failed.';
comment on column public.calendar_appointments.reminder_message_id is
  'A mensagem que levou o lembrete. set null: apagar a mensagem não pode apagar o compromisso.';
comment on column public.calendar_appointments.reminder_armed_at is
  'Quando o lembrete foi armado para o horário vigente (criação ou última remarcação). Só recebe lembrete quem foi armado ANTES do momento devido.';

-- ---------------------------------------------------------------------------
-- 2 · remarcar rearma
-- ---------------------------------------------------------------------------

create or replace function public.fn_calendar_appointments_rearma_lembrete()
returns trigger
language plpgsql
as $function$
begin
  -- `is distinct from` e não `<>`: o sync do Google regrava a linha com o MESMO horário
  -- o tempo todo, e isso não é remarcação.
  if new.starts_at is distinct from old.starts_at then
    new.reminder_state := 'pending';
    new.reminder_detail := null;
    new.reminder_attempts := 0;
    new.reminder_sent_at := null;
    new.reminder_message_id := null;
    new.reminder_armed_at := now();
  end if;
  return new;
end
$function$;

drop trigger if exists trg_calendar_appointments_rearma_lembrete on public.calendar_appointments;
create trigger trg_calendar_appointments_rearma_lembrete
  before update of starts_at on public.calendar_appointments
  for each row
  execute function public.fn_calendar_appointments_rearma_lembrete();

-- ---------------------------------------------------------------------------
-- 3 · os lembretes cujo momento chegou
-- ---------------------------------------------------------------------------

create or replace function public.fn_lembretes_devidos(
  p_now timestamptz,
  p_limit integer default 50
) returns table (appointment_id uuid, organization_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select a.id, a.organization_id
    from public.calendar_appointments a
    join public.calendar_event_types t
      on t.id = a.event_type_id
     and t.organization_id = a.organization_id
   where a.reminder_state = 'pending'
     and a.status in ('pending', 'confirmed')
     and a.contact_id is not null
     and t.reminder_enabled
     and a.starts_at > p_now
     and a.starts_at - make_interval(mins => t.reminder_minutes_before) <= p_now
   order by a.starts_at
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$function$;

comment on function public.fn_lembretes_devidos(timestamptz, integer) is
  'Os compromissos vivos, ainda sem desfecho de lembrete, cujo momento de avisar (starts_at - reminder_minutes_before) já chegou e cujo horário ainda não passou. Só service_role: quem chama é o cron appointment-reminders, que decide o que fazer com cada um.';

revoke all on function public.fn_lembretes_devidos(timestamptz, integer) from public;
revoke all on function public.fn_lembretes_devidos(timestamptz, integer) from anon;
revoke all on function public.fn_lembretes_devidos(timestamptz, integer) from authenticated;
grant execute on function public.fn_lembretes_devidos(timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4 · a Central de avisos aprende que o lembrete pode não sair
-- ---------------------------------------------------------------------------
--
-- Entra no FIM da lista, antes de 'other' (um teste procura 'midia_nao_lida' nos
-- primeiros 2000 caracteres a partir do `add constraint`: valor novo no meio empurra).

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
    'other'
  ));

notify pgrst, 'reload schema';
