-- 0219 — A lista de conversas passa a saber o que a ÚLTIMA MENSAGEM é, e em que pé ela está.
--
-- Pedido do dono (2026-10-28): a lista do Inbox "mais parecida com a do WhatsApp". A linha do
-- WhatsApp diz três coisas que a nossa não dizia, e as três moram na última mensagem:
--
--   · QUEM falou por último ("Você: ..." quando fomos nós);
--   · o TIPO dela (um áudio aparece como 🎤 Áudio, não como o literal "[audio]" que o envio pelo
--     CRM gravava no preview);
--   · o STATUS dela, para os tiques (✓ enviada, ✓✓ entregue, ✓✓ azul lida, relógio na fila, ! se
--     falhou).
--
-- Hoje `conversations` guarda só o TEXTO (`last_message_preview`) e o instante
-- (`last_message_at`). Ler a mensagem na hora de montar a lista custaria uma subconsulta por
-- conversa, e pior: o Realtime da lista escuta `conversations`, não `messages` — um tique que
-- vira azul não mudaria linha nenhuma, e a lista ficaria presa no ✓ cinza até alguém recarregar.
-- Por isso o espelho é DESNORMALIZADO, na própria conversa, e a conversa muda quando a mensagem
-- muda.
--
-- Quatro colunas (todas anuláveis — conversa sem mensagem não tem o que espelhar):
--   · last_message_id         — QUAL mensagem. Sem FK de propósito: apagar mensagem (LGPD, expurgo)
--                               não pode varrer `conversations` atrás da referência, e uma
--                               referência velha é inofensiva (o trigger só casa por igualdade);
--   · last_message_direction  — 'inbound' | 'outbound';
--   · last_message_type       — o `messages.type` dela;
--   · last_message_status     — o `messages.status` dela.
--
-- Quem as mantém:
--   1. `fn_mark_conversation_message` — o carimbo que os três canais de entrada (WhatsApp/WAHA,
--      Meta, Zernio) já chamam. Ganha a leitura da mensagem recém-gravada (a mais recente DAQUELA
--      direção na conversa, pelo índice `idx_messages_conversation_sent`). Os chamadores NÃO mudam:
--      a assinatura é a mesma, e os três gravam a mensagem ANTES de carimbar a conversa;
--   2. o envio pelo CRM (`app/api/v1/messages/_handler.ts`), que carimba a conversa à mão e
--      nunca chamou a função — passa a gravar as mesmas quatro colunas;
--   3. o trigger abaixo, quando o STATUS da mensagem muda (o ack do WhatsApp: enviada → entregue →
--      lida). Só mexe na conversa se a mensagem que mudou É a última dela.
--
-- Limite declarado: "a última" é a mais recente por `sent_at`. Se um provedor reentregar, horas
-- depois, uma mensagem ANTIGA, `last_message_at` já recuava para a hora dela (comportamento da
-- 0027, intocado aqui) e o preview também; as colunas novas apontam a mensagem mais nova daquela
-- direção. É uma divergência de borda que já existia entre `last_message_at` e a ordem real da
-- conversa, não uma nova.
--
-- Idempotente: `add column if not exists`, `create or replace`, `drop trigger if exists`, backfill
-- só onde `last_message_id is null`.

alter table public.conversations
  add column if not exists last_message_id uuid,
  add column if not exists last_message_direction text,
  add column if not exists last_message_type text,
  add column if not exists last_message_status text;

comment on column public.conversations.last_message_id is
  'A mensagem que last_message_preview resume. Sem FK de propósito (apagar mensagem não pode varrer conversations); o trigger de status casa por igualdade. Migration 0219.';
comment on column public.conversations.last_message_direction is
  'inbound | outbound — quem falou por último. A lista mostra "Você:" quando é outbound. Migration 0219.';
comment on column public.conversations.last_message_type is
  'messages.type da última mensagem (text, audio, image...). A lista troca o literal "[audio]" por ícone + rótulo. Migration 0219.';
comment on column public.conversations.last_message_status is
  'messages.status da última mensagem (queued/sending/sent/delivered/read/failed). Vira os tiques da lista; mantido por trg_messages_espelham_status_na_conversa. Migration 0219.';

-- ---- 1. o carimbo dos canais de entrada ----------------------------------------------------
create or replace function public.fn_mark_conversation_message(
  p_conv uuid, p_direction text, p_preview text, p_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_msg record;
begin
  -- A mensagem foi gravada ANTES desta chamada pelos três canais; a mais recente daquela direção
  -- é ela. `sent_at` e não `created_at`: é o que o índice (conversation_id, sent_at desc) serve,
  -- e o WAHA grava `sent_at` com a hora do aparelho enquanto `p_at` é a hora da chegada — os dois
  -- não se igualam, então casar por `p_at` não identificaria a mensagem.
  select m.id, m.type, m.status into v_msg
    from public.messages m
   where m.conversation_id = p_conv
     and m.direction = p_direction
   order by m.sent_at desc, m.created_at desc
   limit 1;

  update public.conversations set
    last_message_at = p_at, last_message_preview = p_preview,
    last_message_id = v_msg.id,
    last_message_direction = p_direction,
    last_message_type = v_msg.type,
    last_message_status = v_msg.status,
    last_inbound_at  = case when p_direction = 'inbound'  then p_at else last_inbound_at  end,
    last_outbound_at = case when p_direction = 'outbound' then p_at else last_outbound_at end,
    unread_count_for_assignee = case
      when p_direction = 'inbound'  then unread_count_for_assignee + 1
      when p_direction = 'outbound' then 0
      else unread_count_for_assignee
    end,
    updated_at = now()
  where id = p_conv;

  update public.contacts c
     set last_activity_at = greatest(coalesce(c.last_activity_at, '-infinity'::timestamptz), p_at)
    from public.conversations v
   where v.id = p_conv
     and c.id = v.contact_id;
end; $$;

comment on function public.fn_mark_conversation_message is
  'Atualiza agregados da conversa (inbound incrementa unread; outbound zera), espelha direção/tipo/status da última mensagem (0219) e carimba contacts.last_activity_at.';

-- Só a ingestão (service role) chama. `create or replace` preserva o ACL que já existia; reafirmar
-- aqui é o cinto de segurança para quem aplica este arquivo num banco cujo ACL foi mexido.
revoke all     on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) from public;
revoke execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) from anon, authenticated;
grant  execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) to service_role;

-- ---- 2. o ack do WhatsApp chega na lista ---------------------------------------------------
create or replace function public.fn_conversa_espelha_status_da_ultima_mensagem()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Só a ÚLTIMA mensagem aparece na linha da lista; o ack de uma mensagem do meio da conversa não
  -- mexe na conversa (e não acorda o Realtime de ninguém). Casa por `id` da conversa (PK) e por
  -- igualdade em `last_message_id`, sem varrer nada.
  update public.conversations c
     set last_message_status = new.status
   where c.id = new.conversation_id
     and c.last_message_id = new.id
     and c.last_message_status is distinct from new.status;
  return null;
end;
$$;

-- SECURITY DEFINER porque o status da mensagem muda pelo webhook (service role) e também por
-- sessão de usuário; sem definer a RLS de `conversations` recusaria a escrita em um dos caminhos e
-- o tique ficaria preso. O que escreve vem SEMPRE de `new` — não há parâmetro, não há superfície
-- para escolher conversa alheia.
revoke all     on function public.fn_conversa_espelha_status_da_ultima_mensagem() from public;
revoke execute on function public.fn_conversa_espelha_status_da_ultima_mensagem() from anon, authenticated;

drop trigger if exists trg_messages_espelham_status_na_conversa on public.messages;
create trigger trg_messages_espelham_status_na_conversa
  after update of status on public.messages
  for each row
  when (old.status is distinct from new.status)
  execute function public.fn_conversa_espelha_status_da_ultima_mensagem();

-- ---- 3. quem já existia ---------------------------------------------------------------------
-- Conversa com histórico e sem espelho (todas, na primeira aplicação). Uma subconsulta correlata
-- por conversa, pelo índice (conversation_id, sent_at desc) — e não um `distinct on` sobre a
-- tabela inteira, que varreria todas as mensagens da instalação.
update public.conversations c
   set (last_message_id, last_message_direction, last_message_type, last_message_status) = (
     select m.id, m.direction, m.type, m.status
       from public.messages m
      where m.conversation_id = c.id
      order by m.sent_at desc, m.created_at desc
      limit 1
   )
 where c.last_message_id is null
   and c.last_message_at is not null;

notify pgrst, 'reload schema';
