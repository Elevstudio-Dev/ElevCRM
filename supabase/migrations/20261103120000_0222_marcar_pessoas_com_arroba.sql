-- 0222 — marcar alguém com @: a marcação ganha lugar para ser GUARDADA, e o banco passa a
-- dizer QUEM pode ser marcado.
--
-- ## O pedido
--
-- "Marcar a pessoa pelo @, igual ao do WhatsApp" — no chat da equipe, na nota interna da
-- conversa e nos grupos de WhatsApp. Ao digitar `@` abre a lista de quem pode ser marcado; o
-- nome escolhido fica em destaque no texto; a pessoa marcada recebe o aviso.
--
-- ## Por que uma coluna, e não só o texto
--
-- Até aqui a nota interna avisava quem fosse citado casando o TEXTO digitado (`@ana`) com o
-- primeiro nome ou o começo do e-mail de cada membro da organização. Isso erra nos dois
-- sentidos: duas Anas recebem o mesmo aviso, e o nome com sobrenome (`@Ana Souza`) que a lista
-- do WhatsApp insere não casaria com nada. A menção passa a ser guardada com o ID de quem foi
-- marcado — `mentions` — e o texto continua sendo só o que se lê.
--
--   team_messages.mentions       jsonb, lista de { tipo: 'pessoa', user_id, nome } | { tipo: 'todos' }
--   conversation_notes.mentions  idem
--
-- `default '[]'` e `not null`: toda mensagem e nota que já existe vale como "sem marcação", e
-- ninguém precisa tratar `null`. O `check` só exige que seja uma lista (o formato de cada item
-- quem confere é a API, com zod, antes de gravar) e a limita a 20 itens.
--
-- ## Quem PODE ser marcado — a regra mora no banco, e não é a mesma nos dois lugares
--
--   canal do chat:    `geral` = toda a equipe; `setor` = quem está no setor e manager+;
--                     `direto` = os dois do par. É a regra de `fn_can_view_team_channel` (0214).
--   nota da conversa: quem ENXERGA a conversa. É a regra de `fn_can_view_conversation` (0213):
--                     manager+ vê tudo; em setor, só quem é do setor (ou quem não está em setor
--                     algum); o agente vê as suas e, conforme `visibility_mode`, as da fila ou
--                     todas.
--
-- Marcar alguém que NÃO vê a conversa seria mandar a essa pessoa um aviso com o começo de uma
-- conversa que ela não pode abrir — o vazamento que a RLS existe para impedir. Por isso a
-- lista que a tela mostra, e a conferência que a API faz antes de avisar, vêm das duas funções
-- abaixo e de mais nenhum lugar.
--
-- Elas devolvem também o e-mail: a nota continua avisando quem for citado só pelo texto digitado
-- à mão (`@ana` casa com o começo do e-mail), como já fazia — agora apenas entre quem vê a
-- conversa. O e-mail não sai da API; a lista que o navegador recebe tem só id, nome e papel.
--
-- As funções existem porque as de RLS leem `auth.uid()` (respondem "EU vejo?") e aqui a
-- pergunta é "QUEM vê?". O invariante `tests/invariants/marcar-com-arroba.test.ts` prova que
-- as duas respostas batem, usuário a usuário, em cada modo de visibilidade.
--
-- ## Quem pode CHAMAR
--
-- Só o `service_role`: a API as chama depois de conferir que quem pediu enxerga o canal ou a
-- conversa (pela conexão do usuário, sob RLS). Elas devolvem nome e papel de colegas — nada que
-- o navegador deva poder pedir direto. `stable security definer`, `search_path` fixo, e
-- `revoke` de `public`, `anon` e `authenticated`, como toda função desta base.

-- ── 1. onde a marcação é guardada ──────────────────────────────────────────
alter table public.team_messages
  add column if not exists mentions jsonb not null default '[]'::jsonb
    constraint team_messages_mentions_lista check (
      jsonb_typeof(mentions) = 'array' and jsonb_array_length(mentions) <= 20
    );

alter table public.conversation_notes
  add column if not exists mentions jsonb not null default '[]'::jsonb
    constraint conversation_notes_mentions_lista check (
      jsonb_typeof(mentions) = 'array' and jsonb_array_length(mentions) <= 20
    );

-- ── 2. quem enxerga uma conversa ───────────────────────────────────────────
-- Os papéis que conversam com a equipe são agent+: `viewer` lê o CRM e não aparece na lista
-- (a API do chat recusaria, e uma marcação que ninguém pode responder é ruído).
create or replace function public.fn_membros_que_veem_conversa(
  p_org uuid,
  p_conversation_id uuid
) returns table (user_id uuid, role text, full_name text, email text)
language sql stable security definer
set search_path = public
as $$
  select uo.user_id,
         uo.role,
         coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)),
         u.email::text
    from public.conversations c
    join public.user_organizations uo
      on uo.organization_id = c.organization_id
     and uo.revoked_at is null
     and uo.role in ('agent', 'manager', 'admin')
    join auth.users u on u.id = uo.user_id
   where c.id = p_conversation_id
     and c.organization_id = p_org
     and (
       -- manager+ vê tudo
       uo.role in ('manager', 'admin')
       or (
         -- Em algum setor, e a conversa é de OUTRO: não vê. Conversa sem setor continua
         -- visível — é a fila antes de o menu responder.
         not (
           c.sector_id is not null
           and exists (
             select 1 from public.sector_members sm
              where sm.organization_id = c.organization_id and sm.user_id = uo.user_id
           )
           and not exists (
             select 1 from public.sector_members sm
              where sm.organization_id = c.organization_id
                and sm.user_id = uo.user_id
                and sm.sector_id = c.sector_id
           )
         )
         and (
           c.assigned_to_user_id = uo.user_id
           or case coalesce(
                (select o.settings ->> 'visibility_mode' from public.organizations o where o.id = c.organization_id),
                'own_and_unassigned')
                when 'all' then true
                when 'own_and_unassigned' then c.assigned_to_user_id is null
                else false
              end
         )
       )
     );
$$;
revoke all on function public.fn_membros_que_veem_conversa(uuid, uuid) from public;
revoke execute on function public.fn_membros_que_veem_conversa(uuid, uuid) from anon, authenticated;
grant execute on function public.fn_membros_que_veem_conversa(uuid, uuid) to service_role;

-- ── 3. quem enxerga um canal do chat da equipe ─────────────────────────────
create or replace function public.fn_membros_do_canal(
  p_org uuid,
  p_channel_id uuid
) returns table (user_id uuid, role text, full_name text, email text)
language sql stable security definer
set search_path = public
as $$
  select uo.user_id,
         uo.role,
         coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)),
         u.email::text
    from public.team_channels c
    join public.user_organizations uo
      on uo.organization_id = c.organization_id
     and uo.revoked_at is null
     and uo.role in ('agent', 'manager', 'admin')
    join auth.users u on u.id = uo.user_id
   where c.id = p_channel_id
     and c.organization_id = p_org
     and case c.kind
           when 'geral' then true
           when 'setor' then
             uo.role in ('manager', 'admin')
             or exists (
               select 1 from public.sector_members sm
                where sm.organization_id = c.organization_id
                  and sm.sector_id = c.sector_id
                  and sm.user_id = uo.user_id
             )
           when 'direto' then
             exists (
               select 1 from public.team_channel_members m
                where m.channel_id = c.id and m.user_id = uo.user_id
             )
           else false
         end;
$$;
revoke all on function public.fn_membros_do_canal(uuid, uuid) from public;
revoke execute on function public.fn_membros_do_canal(uuid, uuid) from anon, authenticated;
grant execute on function public.fn_membros_do_canal(uuid, uuid) to service_role;
