-- 0216 — a CONVERSA de um grupo de WhatsApp passa a ser achada pela chave do grupo.
--
-- ## O defeito, medido
--
-- Numa instalação real: **9 grupos, cada um com DUAS conversas** — uma com o
-- `group_chat_id` e quase nada dentro (0 a 4 mensagens), outra SEM o id e com a
-- história inteira (de 19 a 314 mensagens). O envio para grupo falhava com
-- "Contato sem telefone para envio WhatsApp", porque a resolução do destino lê
-- `conversations.group_chat_id` e grupo não tem telefone para cair de volta.
-- O log do servidor guardava a causa, 890 vezes igual:
--
--     waha.ingest: conversa de grupo ficou sem a marca de grupo
--     duplicate key value violates unique constraint
--     "conversations_unique_per_contact_session"
--
-- ## O mecanismo
--
-- `fn_upsert_wa_conversation` resolve por `(organização, contato, sessão) WHERE
-- is_group = false`. O ingest a chamava para o grupo e DEPOIS carimbava a
-- conversa com um UPDATE (`is_group = true`, `group_chat_id = X`):
--
--   1ª mensagem → a função cria C1 (is_group=false); o carimbo a marca. Certo.
--   2ª mensagem → a função só enxerga `is_group = false`, não acha C1 (já é
--                 true) e cria C2; o carimbo tenta pôr o MESMO `X` em C2 e
--                 colide com o índice `(org, contato, sessão, group_chat_id)`.
--   3ª em diante → a função acha C2 (is_group=false) e a devolve; o carimbo
--                 falha de novo, a cada mensagem.
--
-- Um UPDATE depois do fato não tem como consertar isto: o índice único já
-- reservou o `X` para C1. A conversa do grupo precisa ser ACHADA OU CRIADA já
-- pela chave do grupo, numa operação só — e é isso que esta função faz.
--
-- ## Por que uma função nova, e não um parâmetro na existente
--
-- Pelo mesmo motivo que a 0210 deu uma RPC própria ao CONTATO do grupo:
-- `fn_upsert_wa_conversation` é compartilhada pelos três canais, tem grants
-- próprios, e acrescentar um modo a ela mexe na superfície mais usada do ingest
-- para ganhar um parâmetro a menos. Função nova, contrato próprio, mesma
-- postura de segurança.
--
-- ## Atômica, e é por isso que não tem corrida
--
-- `insert … on conflict (org, contato, sessão, group_chat_id) do update`: duas
-- mensagens simultâneas do mesmo grupo caem na mesma linha em vez de uma criar
-- e a outra colidir. A alternativa — buscar por id e criar se faltar, no
-- aplicativo — reabre exatamente a janela entre o "não achei" e o "criei".
--
-- O `do update` também recoloca `is_group = true`: se alguma linha antiga tiver
-- o id sem a marca, a próxima mensagem a cura em vez de deixá-la meio grupo.
--
-- ## O que esta migration NÃO faz
--
-- Não mexe nos dados. As conversas duplicadas que já existem continuam lá: esta
-- função faz as mensagens NOVAS irem para a conversa certa (a que tem o id), e
-- a fusão do que ficou para trás é um reparo à parte, com cópia de segurança.

create or replace function public.fn_upsert_wa_group_conversation(
  p_org uuid,
  p_contact uuid,
  p_session uuid,
  p_group_chat_id text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_chat text := nullif(trim(p_group_chat_id), '');
begin
  -- Sem chave não há conversa de grupo: devolver null deixa o chamador decidir.
  if v_chat is null then
    return null;
  end if;

  insert into public.conversations (
    organization_id, contact_id, channel_session_id, channel, status,
    is_group, group_chat_id, unread_count_for_assignee, metadata
  ) values (
    p_org, p_contact, p_session, 'whatsapp', 'open',
    true, v_chat, 0, '{}'::jsonb
  )
  on conflict (organization_id, contact_id, channel_session_id, group_chat_id)
  do update set is_group = true, updated_at = now()
  returning id into v_id;

  return v_id;
end
$function$;

comment on function public.fn_upsert_wa_group_conversation(uuid, uuid, uuid, text) is
  'Acha ou cria a conversa de um GRUPO de WhatsApp pela chave (org, contato, sessão, group_chat_id), numa operação só. Existe porque fn_upsert_wa_conversation só enxerga is_group=false e, para grupo, criava uma segunda conversa a cada carimbo que colidia.';

revoke all on function public.fn_upsert_wa_group_conversation(uuid, uuid, uuid, text) from public;
revoke all on function public.fn_upsert_wa_group_conversation(uuid, uuid, uuid, text) from anon;
revoke all on function public.fn_upsert_wa_group_conversation(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.fn_upsert_wa_group_conversation(uuid, uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
