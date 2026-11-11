-- 0226 — Mensagem IMPORTADA do histórico do WhatsApp não vira evento de "mensagem nova".
--
-- ## O pedido
--
-- "Puxar todas as mensagens daquele contato que tem no WhatsApp": o botão traz conversa ANTIGA para dentro do CRM.
--
-- ## O risco que esta migration fecha
--
-- O gatilho `trg_messages_emit_event` roda AFTER INSERT em `messages`, sem filtrar a origem, e chama
-- `fn_emit_message_event` — que grava `message.received` / `message.outbound`. Os consumidores desse evento são o
-- modelo de sentimento (chamada paga), as automações da empresa e o follow-up. Importar 400 mensagens de 2025
-- dispararia 400 classificações pagas, automações "ao receber mensagem" sobre conversa de meses atrás e janelas de
-- follow-up contadas a partir de hoje.
--
-- ## O que muda
--
-- A função passa a não emitir NADA quando a linha chega marcada `metadata.historico_importado = true`. A marca é
-- escrita só pelo caminho de importação (`lib/inbox/importar-historico.ts`); a mensagem normal não a tem e segue
-- idêntica. Mesma assinatura e mesmo retorno — `create or replace` basta, e o `baseline.sql` (que o `update.sh`
-- reaplica) é atualizado no mesmo bloco.
--
-- ## O que NÃO muda
--
-- Nenhum dado é tocado. Nenhum grant. A função continua sem `security definer`.

create or replace function public.fn_emit_message_event() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_event text;
begin
  -- Histórico importado: a mensagem já aconteceu antes de o CRM conhecê-la. Registrá-la não é um fato novo.
  if coalesce(new.metadata ->> 'historico_importado', '') = 'true' then
    return new;
  end if;

  if new.direction = 'inbound' then
    v_event := 'message.received';
  else
    v_event := case new.status
                 when 'sending' then 'message.sending'
                 when 'sent' then 'message.sent'
                 when 'failed' then 'message.failed'
                 else 'message.outbound'
               end;
  end if;

  perform public.fn_log_event(
    new.organization_id, v_event,
    jsonb_build_object(
      'message_id', new.id, 'conversation_id', new.conversation_id,
      'contact_id', new.contact_id, 'direction', new.direction,
      'type', new.type, 'status', new.status, 'external_id', new.external_id,
      'channel_session_id', new.channel_session_id,
      'body_preview', "left"(new.body, 280)
    )
  );
  return new;
end$$;
