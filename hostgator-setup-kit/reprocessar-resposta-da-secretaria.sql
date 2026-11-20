-- REPROCESSAR A RESPOSTA DE UMA SECRETÁRIA QUE NÃO FOI APLICADA
--
-- Quem chama é `reprocessar-resposta-da-secretaria.sh` (e o invariante
-- tests/invariants/reprocessar-resposta-da-secretaria.test.ts, contra um Postgres de verdade).
--
-- Variáveis (psql -v):
--   org      uuid da organização (OBRIGATÓRIA: tudo aqui filtra por ela)
--   msg      uuid da mensagem do "sim" dela        ┐
--   relato   uuid do relato (o resumo) que ela aprovou ├ pelo menos UMA das três
--   job      uuid do job `bastidor_turn` que morreu    ┘ (o `ref_id` do aviso da Central)
--   aplicar  0 = só mostra (padrão)   1 = enfileira UM job `bastidor_turn` novo
--
-- O que ESCREVE: no máximo UMA linha em `job_queue` (com `--aplicar`), e só isso. Quem aplica a agenda é o worker,
-- pelo caminho de sempre (o turno da secretaria): este script não toca em agenda, relato nem mensagem.
--
-- O que RECUSA (e por quê) está em cada `raise exception 'Recusado: …'` abaixo: relato que não está `lido`, um
-- resumo mais novo, resposta fora das 12 h, outra resposta nossa depois do "sim", turno dela já na fila.
--
-- O que IMPRIME: só o que o operador precisa para conferir — os horários e nomes do RELATO (dado do operador) e a
-- última mensagem que o turno vai ler, cortada em 40 caracteres. Nenhum texto vai para log do app.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
\o /dev/null
select set_config('reprocessar.org', :'org', false),
       set_config('reprocessar.msg', :'msg', false),
       set_config('reprocessar.relato', :'relato', false),
       set_config('reprocessar.job', :'job', false),
       set_config('reprocessar.aplicar', :'aplicar', false);
\o
create temp table reprocessar_relatorio (n serial primary key, linha text not null);

do $reprocessar$
declare
  v_org          uuid    := current_setting('reprocessar.org')::uuid;
  v_msg          uuid    := nullif(current_setting('reprocessar.msg'), '')::uuid;
  v_relato_id    uuid    := nullif(current_setting('reprocessar.relato'), '')::uuid;
  v_job_id       uuid    := nullif(current_setting('reprocessar.job'), '')::uuid;
  v_aplicar      boolean := current_setting('reprocessar.aplicar') = '1';
  -- As mesmas regras do turno (lib/bastidor/secretaria/turno.ts e lib/agent-engine/agent/bastidor-mensagens.ts).
  c_validade     constant interval := interval '12 hours';
  c_automaticas  constant text[]   := array['perguntar', 'lembrar', 'lembrar_conferencia'];
  c_acentos      constant text     := 'áàâãäåéèêëíìîïóòôõöúùûüçñ';
  c_sem_acento   constant text     := 'aaaaaaeeeeiiiiooooouuuucn';
  v_org_tz       text;
  v_settings     jsonb;
  v_dono         uuid;
  v_fuso         text;
  v_duracao      int;
  v_rel          record;
  v_m_contato    uuid;
  v_m_quando     timestamptz;
  v_m_direcao    text;
  v_do_job       uuid;
  v_conversa     uuid;
  v_sessao       uuid;
  v_papel        text;
  v_fronteira    record;
  v_qtd          int;
  v_ultima       record;
  v_payload      jsonb;
  v_original     uuid;
  v_novo         uuid;
  v_ini_janela   timestamptz;
  v_fim_janela   timestamptz;
  v_carimbo      timestamptz;
  v_ultima_conf  timestamptz;
  v_hoje_h       numeric;
  v_futuro_h     numeric;
  v_idade        interval;
  v_estado       text;
  x              record;
begin
  -- ── 0. O que foi pedido ────────────────────────────────────────────────────────────────────────────────────────
  if v_msg is null and v_relato_id is null and v_job_id is null then
    raise exception 'Recusado: informe a mensagem do "sim" (--mensagem), o relato (--relato) ou o job que morreu (--job).';
  end if;

  select o.timezone, o.settings into v_org_tz, v_settings from organizations o where o.id = v_org;
  if not found then raise exception 'Recusado: a organização % não existe.', v_org; end if;

  -- O job que morreu (o aviso da Central aponta para ele): dele sai a mensagem.
  if v_job_id is not null then
    select nullif(j.payload->>'inbound_message_id', '')::uuid into v_do_job
      from job_queue j
     where j.organization_id = v_org and j.id = v_job_id and j.kind = 'bastidor_turn';
    if not found then
      raise exception 'Recusado: o job % não é um turno da secretaria nesta organização.', v_job_id;
    end if;
    if v_do_job is null then
      raise exception 'Recusado: o job % não nasceu de uma mensagem dela (é do cron ou da reserva).', v_job_id;
    end if;
    if v_msg is not null and v_msg <> v_do_job then
      raise exception 'Recusado: o job % é da mensagem %, não da %.', v_job_id, v_do_job, v_msg;
    end if;
    v_msg := v_do_job;
  end if;

  -- ── 1. A mensagem e o relato ───────────────────────────────────────────────────────────────────────────────────
  if v_msg is not null then
    select m.conversation_id, m.contact_id, m.direction, coalesce(m.sent_at, m.created_at)
      into v_conversa, v_m_contato, v_m_direcao, v_m_quando
      from messages m where m.organization_id = v_org and m.id = v_msg;
    if not found then raise exception 'Recusado: a mensagem % não existe nesta organização.', v_msg; end if;
    if v_m_direcao <> 'inbound' then
      raise exception 'Recusado: a mensagem % não foi ENVIADA por ela (é uma saída nossa).', v_msg;
    end if;
  end if;

  if v_relato_id is not null then
    select r.* into v_rel from agenda_relatos r where r.organization_id = v_org and r.id = v_relato_id;
    if not found then raise exception 'Recusado: o relato % não existe nesta organização.', v_relato_id; end if;
  else
    -- O resumo que ela estava respondendo: o mais recente DELA criado antes da mensagem.
    select r.* into v_rel from agenda_relatos r
     where r.organization_id = v_org and r.contact_id = v_m_contato and r.created_at <= v_m_quando
     order by r.created_at desc limit 1;
    if not found then raise exception 'Recusado: não há resumo dela antes dessa mensagem.'; end if;
  end if;

  if v_conversa is null then
    select m.conversation_id into v_conversa from messages m where m.organization_id = v_org and m.id = v_rel.message_id;
    if v_conversa is null then
      raise exception 'Recusado: o relato % não diz de qual conversa veio — informe a mensagem do "sim" (--mensagem).', v_rel.id;
    end if;
  end if;

  select c.papel_interno into v_papel from contacts c where c.organization_id = v_org and c.id = v_rel.contact_id;
  if v_papel is distinct from 'secretaria' then
    raise exception 'Recusado: o contato do relato não tem (mais) o papel de secretaria.';
  end if;
  if v_m_contato is not null and v_m_contato <> v_rel.contact_id then
    raise exception 'Recusado: a mensagem e o relato são de pessoas diferentes.';
  end if;
  select c.channel_session_id into v_sessao from conversations c where c.organization_id = v_org and c.id = v_conversa;

  -- ── 2. O relato precisa estar esperando o "sim", e ser o mais novo dela ────────────────────────────────────────
  if v_rel.estado <> 'lido' then
    raise exception 'Recusado: o relato está "%" — só um relato "lido" espera o "sim" (nada a reprocessar).', v_rel.estado;
  end if;
  if exists (
    select 1 from agenda_relatos r
     where r.organization_id = v_org and r.contact_id = v_rel.contact_id
       and r.created_at > v_rel.created_at and r.estado in ('lido', 'conferido')
  ) then
    raise exception 'Recusado: há um resumo MAIS NOVO dela (o turno confirmaria aquele, não este).';
  end if;

  -- ── 3. O que o turno vai ler: a mesma fronteira de bastidor-mensagens.ts ───────────────────────────────────────
  select s.quando, (l.id is not null) as do_agente into v_fronteira
    from (
      select coalesce(m.sent_at, m.created_at) as quando, m.created_at, m.metadata->>'idempotency_key' as chave
        from messages m
       where m.organization_id = v_org and m.conversation_id = v_conversa and m.direction = 'outbound'
         and m.status is distinct from 'failed'
       order by 1 desc, 2 desc limit 200
    ) s
    left join send_ledger l
      on l.organization_id = v_org
     and l.id = (case when s.chave ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                      then s.chave::uuid end)
    left join job_queue j on j.id = l.job_id
   where not coalesce(j.kind = 'bastidor_turn' and j.payload->>'acao' = any(c_automaticas), false)
   order by s.quando desc, s.created_at desc
   limit 1;

  select count(*) into v_qtd from (
    select 1 from messages m
     where m.organization_id = v_org and m.conversation_id = v_conversa and m.direction = 'inbound'
       and coalesce(m.sent_at, m.created_at) > coalesce(v_fronteira.quando, 'epoch'::timestamptz)
     order by coalesce(m.sent_at, m.created_at) desc limit 15
  ) lidas;
  select m.id, coalesce(m.sent_at, m.created_at) as quando,
         left(regexp_replace(coalesce(nullif(btrim(m.body), ''), m.media_derived_text, ''), '\s+', ' ', 'g'), 40) as previa
    into v_ultima
    from messages m
   where m.organization_id = v_org and m.conversation_id = v_conversa and m.direction = 'inbound'
     and coalesce(m.sent_at, m.created_at) > coalesce(v_fronteira.quando, 'epoch'::timestamptz)
   order by coalesce(m.sent_at, m.created_at) desc, m.created_at desc limit 1;

  if v_m_quando is not null and v_m_quando <= coalesce(v_fronteira.quando, 'epoch'::timestamptz) then
    raise exception 'Recusado: depois dessa mensagem já houve resposta nossa (ou da equipe) — o turno não a leria. Peça a agenda de novo.';
  end if;
  if v_qtd = 0 then
    raise exception 'Recusado: depois da última resposta nossa ela não escreveu nada — o turno não teria o que ler.';
  end if;
  if v_msg is null then v_msg := v_ultima.id; end if;

  -- A validade vai até quando ELA RESPONDEU (a última mensagem que o turno lê), não até agora.
  if v_ultima.quando - v_rel.created_at > c_validade then
    raise exception 'Recusado: ela respondeu % depois do resumo (mais de 12 h): o resumo venceu de verdade. Peça a agenda de novo.',
      date_trunc('minute', v_ultima.quando - v_rel.created_at);
  end if;

  -- ── 4. Configuração da agenda ──────────────────────────────────────────────────────────────────────────────────
  v_dono := nullif(v_settings->'secretaria'->>'dono_da_agenda_user_id', '')::uuid;
  if v_dono is null then
    raise exception 'Recusado: a agenda da secretaria não tem dono configurado (Configurações → Secretaria). Configure e rode de novo.';
  end if;
  select nullif(btrim(a.schedule->>'timezone'), '') into v_fuso
    from attendant_availability a where a.organization_id = v_org and a.user_id = v_dono;
  v_fuso := coalesce(v_fuso, v_org_tz, 'America/Sao_Paulo');
  v_duracao := coalesce((v_settings->'secretaria'->>'duracao_min')::int, 30);
  v_ini_janela := (v_rel.janela_de::timestamp) at time zone v_fuso;
  v_fim_janela := ((v_rel.janela_ate + 1)::timestamp) at time zone v_fuso;

  -- ── 5. Turno dela já na fila? Então não empilha outro ──────────────────────────────────────────────────────────
  if exists (
    select 1 from job_queue j
     where j.organization_id = v_org and j.contact_id = v_rel.contact_id and j.kind = 'bastidor_turn'
       and j.status in ('pending', 'running')
  ) then
    raise exception 'Recusado: já há um turno da secretaria na fila (pendente ou rodando). Espere ele terminar e confira.';
  end if;

  -- ── 5b. O carimbo e a frescura (a mesma regra de lib/agenda/secretaria/relatos.ts e atualidade.ts) ────────────
  -- O carimbo é min(agora, resposta dela). A frescura usa a conferência MAIS RECENTE da organização depois disso.
  v_carimbo := least(now(), v_ultima.quando);
  select max(r.conferido_em) into v_ultima_conf
    from agenda_relatos r where r.organization_id = v_org and r.estado = 'conferido';
  v_hoje_h := case when jsonb_typeof(v_settings->'secretaria'->'validade_hoje_horas') = 'number'
                   then (v_settings->'secretaria'->>'validade_hoje_horas')::numeric else 6 end;
  v_futuro_h := case when jsonb_typeof(v_settings->'secretaria'->'validade_futuro_horas') = 'number'
                     then (v_settings->'secretaria'->>'validade_futuro_horas')::numeric else 24 end;
  v_idade := greatest(now() - greatest(v_carimbo, coalesce(v_ultima_conf, v_carimbo)), interval '0');
  v_estado := case when v_idade <= v_hoje_h * interval '1 hour' then 'atual'
                   when v_idade <= v_futuro_h * interval '1 hour' then 'sem_hoje'
                   else 'desatualizada' end;

  -- ── 6. O relatório ─────────────────────────────────────────────────────────────────────────────────────────────
  insert into reprocessar_relatorio (linha) values
    ('Organização: ' || v_org),
    ('Relato (resumo): ' || v_rel.id || ' · estado ' || v_rel.estado || ' · criado ' ||
       to_char(v_rel.created_at at time zone v_fuso, 'DD/MM HH24:MI') || ' (' || v_fuso || ')'),
    ('Janela: ' || v_rel.janela_de || ' a ' || v_rel.janela_ate || ' · ' ||
       jsonb_array_length(coalesce(v_rel.lido->'marcados', '[]'::jsonb)) || ' horário(s) · ' ||
       jsonb_array_length(coalesce(v_rel.lido->'dias_fechados', '[]'::jsonb)) || ' dia(s) fechado(s)'),
    ('Mensagem do "sim": ' || v_msg),
    ('O turno vai ler ' || v_qtd || ' mensagem(ns) dela; a última, ' ||
       to_char(v_ultima.quando at time zone v_fuso, 'DD/MM HH24:MI') || ': "' || v_ultima.previa || '"'),
    ('Última resposta nossa antes disso: ' ||
       case when v_fronteira.quando is null then 'nenhuma'
            when v_fronteira.do_agente then 'do agente (o resumo ou uma resposta fixa)'
            else 'HUMANA — o turno vai reenviar o resumo perguntando se o "sim" é para ele (não aplica direto)' end),
    ('Validade: ela respondeu ' || date_trunc('minute', v_ultima.quando - v_rel.created_at) ||
       ' depois do resumo (limite 12 h) → vale'),
    ('Carimbo de conferência (conferido_em): ' || to_char(v_carimbo at time zone v_fuso, 'DD/MM HH24:MI') ||
       ' — a hora em que ela respondeu, não a do reprocessamento'),
    ('Frescura da agenda depois de aplicar, agora: ' || v_estado || ' (validades da clínica: hoje ' || v_hoje_h ||
       ' h, próximos dias ' || v_futuro_h || ' h) → ' ||
       case v_estado
         when 'atual' then 'a IA de vendas oferece todos os horários'
         when 'sem_hoje' then 'a IA de vendas só oferece de amanhã em diante'
         else 'a IA de vendas NÃO oferece horários (chama a equipe) — os espelhos entram na agenda mesmo assim; para voltar a oferecer, peça uma agenda nova à secretária'
       end),
    ('Prévia do que o "sim" faz na agenda (aproximada; quem decide é o aplicador, lib/agenda/secretaria/aplicar.ts):');

  -- Os horários do relato, cada um com o que vai acontecer.
  for x in
    with marcados as (
      select distinct on (k.inicio, k.chave) k.nome, k.inicio, k.chave
        from (
          select e->>'nome' as nome, (e->>'inicio')::timestamptz as inicio,
                 translate(lower(regexp_replace(btrim(e->>'nome'), '\s+', ' ', 'g')), c_acentos, c_sem_acento) as chave
            from jsonb_array_elements(coalesce(v_rel.lido->'marcados', '[]'::jsonb)) e
        ) k
    ),
    vivos as (
      select a.title, a.starts_at, a.origem_relato_id is not null as do_relato,
             translate(lower(regexp_replace(btrim(a.title), '\s+', ' ', 'g')), c_acentos, c_sem_acento) as chave,
             translate(lower(regexp_replace(btrim(coalesce(ct.display_name, '')), '\s+', ' ', 'g')), c_acentos, c_sem_acento)
               as chave_contato
        from calendar_appointments a
        left join contacts ct on ct.organization_id = v_org and ct.id = a.contact_id
       where a.organization_id = v_org and a.owner_user_id = v_dono
         and a.status in ('pending', 'confirmed')
         and a.starts_at >= v_ini_janela and a.starts_at < v_fim_janela
    )
    select mk.inicio, mk.nome,
           case
             when exists (select 1 from vivos v where v.do_relato and v.starts_at = mk.inicio and v.chave = mk.chave)
               then 'mantém'
             -- O MESMO paciente já marcado por outro caminho (IA de vendas): nada a fazer, nada a avisar.
             when mk.chave <> '' and exists (
               select 1 from vivos v
                where not v.do_relato and v.starts_at = mk.inicio
                  and (position(mk.chave in v.chave) > 0 or position(mk.chave in v.chave_contato) > 0))
               then 'já está na agenda (marcado por outro caminho)'
             when exists (select 1 from vivos v where not v.do_relato and v.starts_at = mk.inicio)
               then 'NÃO cria (já há outro compromisso nesse horário — vai na resposta a ela)'
             when exists (select 1 from vivos v where v.do_relato and v.starts_at = mk.inicio)
               then 'troca: cancela "' || (select v.title from vivos v where v.do_relato and v.starts_at = mk.inicio limit 1) || '" e cria'
             else 'cria'
           end as acao
      from marcados mk
     order by mk.inicio, mk.nome
  loop
    insert into reprocessar_relatorio (linha)
      values ('  ' || to_char(x.inicio at time zone v_fuso, 'DD/MM HH24:MI') || ' ' || x.nome || ' → ' || x.acao);
  end loop;

  -- O que um relato criou, ainda não passou, e sumiu do relato novo: é cancelado.
  for x in
    select a.title, a.starts_at
      from calendar_appointments a
     where a.organization_id = v_org and a.owner_user_id = v_dono and a.origem_relato_id is not null
       and a.status in ('pending', 'confirmed')
       and a.starts_at >= v_ini_janela and a.starts_at < v_fim_janela and a.ends_at >= now()
       and not exists (
         select 1 from jsonb_array_elements(coalesce(v_rel.lido->'marcados', '[]'::jsonb)) e
          where (e->>'inicio')::timestamptz = a.starts_at
       )
     order by a.starts_at
  loop
    insert into reprocessar_relatorio (linha)
      values ('  ' || to_char(x.starts_at at time zone v_fuso, 'DD/MM HH24:MI') || ' ' || x.title || ' → cancela (sumiu do relato)');
  end loop;

  for x in
    select (d->>'data')::date as dia,
           exists (select 1 from calendar_availability_exceptions ex
                    where ex.organization_id = v_org and ex.user_id = v_dono and ex.exception_date = (d->>'data')::date) as ja
      from jsonb_array_elements(coalesce(v_rel.lido->'dias_fechados', '[]'::jsonb)) d
     order by 1
  loop
    insert into reprocessar_relatorio (linha)
      values ('  dia ' || to_char(x.dia, 'DD/MM') || ' → ' || case when x.ja then 'já está fechado' else 'fecha' end);
  end loop;

  for x in
    select ex.exception_date as dia
      from calendar_availability_exceptions ex
     where ex.organization_id = v_org and ex.user_id = v_dono and ex.reason like '[secretaria] %'
       and ex.exception_date between v_rel.janela_de and v_rel.janela_ate
       and not exists (select 1 from jsonb_array_elements(coalesce(v_rel.lido->'dias_fechados', '[]'::jsonb)) d
                        where (d->>'data')::date = ex.exception_date)
     order by 1
  loop
    insert into reprocessar_relatorio (linha) values ('  dia ' || to_char(x.dia, 'DD/MM') || ' → reabre (o relato não fecha mais)');
  end loop;

  -- ── 7. Enfileirar (só com --aplicar) ───────────────────────────────────────────────────────────────────────────
  -- O payload é o do job ORIGINAL dessa mensagem (o que morreu), com a marca de onde veio. Sem `source_event_id`: o
  -- job original já ocupa a chave do evento, e a dedup da fila recusaria a cópia.
  select j.id, j.payload into v_original, v_payload
    from job_queue j
   where j.organization_id = v_org and j.kind = 'bastidor_turn' and j.payload->>'inbound_message_id' = v_msg::text
   order by j.created_at desc limit 1;
  v_payload := coalesce(v_payload, jsonb_build_object(
                 'conversation_id', v_conversa,
                 'contact_id', v_rel.contact_id,
                 'channel_session_id', v_sessao,
                 'inbound_message_id', v_msg))
               || jsonb_build_object('reprocessado_de', v_original);

  if v_aplicar then
    insert into job_queue (organization_id, contact_id, kind, payload)
      values (v_org, v_rel.contact_id, 'bastidor_turn', v_payload)
      returning id into v_novo;
    insert into reprocessar_relatorio (linha) values
      ('ENFILEIRADO: job ' || v_novo || ' (bastidor_turn' ||
         coalesce(', cópia do job ' || v_original, ', payload montado da mensagem') || ').'),
      ('O worker processa em segundos. Confira a conversa dela (a confirmação "Pronto, agenda atualizada") e a agenda.');
  else
    insert into reprocessar_relatorio (linha) values
      ('PRÉVIA: nada foi alterado.' ||
         coalesce(' O job novo copiaria o payload do job ' || v_original || '.', ' O payload do job novo seria montado da mensagem.')),
      ('Para enfileirar, rode de novo com --aplicar.');
  end if;
end
$reprocessar$;

select linha from reprocessar_relatorio order by n;
