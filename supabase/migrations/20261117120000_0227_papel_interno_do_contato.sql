-- ============================================================================
-- 0227 — PAPEL INTERNO DO CONTATO (secretaria, marketing).
--
-- Pedido do dono da clínica-piloto: a IA precisa conversar com a EQUIPE para fazer o trabalho — perguntar à
-- secretaria como está a agenda e confirmar horário com ela; receber de quem cuida do marketing o briefing de uma
-- campanha. Hoje todo contato da equipe é só "fora do funil" (0221): a IA se cala diante dele. Faltava dizer QUEM é
-- quem, para o agente de bastidor poder escrever só a essas pessoas e só o que o papel comporta.
--
--  * `contacts.papel_interno`  — 'secretaria' | 'marketing' | nulo (o padrão: contato comum).
--  * CHECK de valor            — o banco recusa papel desconhecido, não só a API.
--  * CHECK de coerência        — quem tem papel TEM de estar fora do funil. Não dá para virar paciente por engano
--                                (e receber follow-up de venda) sem antes tirar o papel.
--  * trigger de guarda         — só gerente ou admin define papel. O marketing consegue disparar campanha, então um
--                                atendente não pode se promover (ou promover um número qualquer) por uma chamada
--                                direta à API do banco. Backend com service role (sem sessão de usuário) passa.
--  * índice parcial            — achar a secretaria e o marketing de uma organização é uma leitura barata.
--
-- Aditiva e idempotente; nenhum dado é tocado.
-- ============================================================================

alter table public.contacts
  add column if not exists papel_interno text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_papel_interno_valido') then
    alter table public.contacts
      add constraint contacts_papel_interno_valido
      check (papel_interno is null or papel_interno in ('secretaria', 'marketing'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_papel_interno_fora_do_funil') then
    alter table public.contacts
      add constraint contacts_papel_interno_fora_do_funil
      check (papel_interno is null or fora_do_funil_em is not null);
  end if;
end $$;

create index if not exists contacts_papel_interno_idx
  on public.contacts (organization_id, papel_interno) where papel_interno is not null;

create or replace function public.fn_contacts_papel_interno_guarda() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.papel_interno is null then
      return new;
    end if;
  elsif new.papel_interno is not distinct from old.papel_interno then
    return new;
  end if;

  -- Sessão de usuário (há `auth.uid()`): precisa ser gerente ou admin da organização do contato. Sem sessão é o
  -- backend com service role, que já passou pela checagem de papel da rota.
  if auth.uid() is not null and not public.fn_role_at_least(new.organization_id, 'manager') then
    raise exception 'papel_interno: só gerente ou admin define o papel de um contato'
      using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function public.fn_contacts_papel_interno_guarda() from public, anon, authenticated;

drop trigger if exists trg_contacts_papel_interno_guarda on public.contacts;
create trigger trg_contacts_papel_interno_guarda
  before insert or update of papel_interno on public.contacts
  for each row execute function public.fn_contacts_papel_interno_guarda();
