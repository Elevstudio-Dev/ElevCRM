-- 0229 — o turno de BASTIDOR: a IA conversando com a equipe (secretaria, marketing).
--
-- A mensagem de um contato com `papel_interno` (0227) não pode ir ao agente de vendas: ele nunca atende a equipe.
-- Ela vira um job de tipo PRÓPRIO, `bastidor_turn`, com handler e regras próprios. Mesma razão do `operator_turn`
-- (0111): o disparo é imposto pelo runtime, por evento, e não por decisão do modelo que conversa.
--
-- DOIS CHECKs, não um (o segundo morre calado se esquecido): `job_queue` exige coerência entre kind e contact_id, e
-- `bastidor_turn` TEM contato — sem estender a lista, todo insert viola a constraint e a secretaria nunca é ouvida.
--
-- No baseline.sql a mudança entra NO BLOCO ÚNICO das duas constraints (não num bloco novo no fim): reconstruir a
-- mesma constraint em dois blocos quebra o update.sh de todo clone com dados (tests/unit/baseline-constraint-reconstruida.test.ts).

-- 1) o kind novo é aceito
alter table job_queue drop constraint if exists job_queue_kind_check;
alter table job_queue add constraint job_queue_kind_check
  check (kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn','bastidor_turn'));

-- 2) coerência kind ⇔ contato (a busca no catálogo cobre o CHECK anônimo de bancos antigos e o nomeado dos novos)
alter table job_queue drop constraint if exists job_queue_turn_needs_contact;
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'job_queue'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%contact_id is not null%';
  if c is not null then execute format('alter table job_queue drop constraint %I', c); end if;
end $$;
alter table job_queue add constraint job_queue_turn_needs_contact
  check ((kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn','bastidor_turn')) = (contact_id is not null));
