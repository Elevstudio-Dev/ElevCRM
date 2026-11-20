/**
 * O QUE A SECRETARIA ESCREVEU desde a última resposta nossa — a leitura que decide o que é "o turno" dela.
 *
 * Separado do handler (`bastidor-turn.ts`) porque só fala `pg` (sem canal, sem modelo): assim a consulta é
 * provada contra o Postgres de verdade (`tests/invariants/bastidor-sim-depois-do-lembrete.test.ts`).
 *
 * ## O "sim" que se perdia (produção)
 *
 * A fronteira era a última mensagem de saída de QUALQUER tipo. O cron das perguntas diárias manda, por cima de um
 * resumo ainda sem confirmação, "Antes de encerrar o dia: como ficou a agenda…" e "Só relembrando a agenda…"; dali em
 * diante o "sim" dela ficava ANTES da fronteira e o turno lia texto vazio. Agora a fronteira IGNORA as mensagens
 * AUTOMÁTICAS de agenda — as que um job `bastidor_turn` do cron mandou (`payload.acao` em `ACOES_AUTOMATICAS`).
 *
 * ## Como a mensagem automática é reconhecida (o mecanismo real, sem coluna nova)
 *
 *     messages.metadata->>'idempotency_key'  =  send_ledger.id      (send-message.ts grava assim todo envio do agente)
 *     send_ledger.job_id                     →  job_queue.id
 *     job_queue.kind = 'bastidor_turn'  e  job_queue.payload->>'acao' ∈ ACOES_AUTOMATICAS
 *
 * Funciona para o que JÁ está no banco (as mensagens de produção foram gravadas assim), que é o que o
 * reprocessamento da resposta da secretaria precisa. Contam como "resposta nossa" (fronteira): o resumo e as
 * respostas fixas do turno (job `bastidor_turn` sem `acao` — o que nasce de uma mensagem dela), a pergunta e o aviso de
 * reserva (`acao` de reserva), e qualquer mensagem sem ledger (humana: do aparelho ou da tela do CRM). Mensagem de
 * saída que FALHOU (`status = 'failed'`) não chegou a ela e não é fronteira.
 */
import type pg from 'pg';

/** O `payload.acao` dos jobs do cron que falam com a secretaria sem ela ter puxado: pergunta, lembrete, cobrança do resumo. */
export const ACOES_AUTOMATICAS_DA_AGENDA = ['perguntar', 'lembrar', 'lembrar_conferencia'] as const;

/** Quantas mensagens em rajada entram num turno. Mais que isso é conversa, não rajada. */
export const MAXIMO_DE_MENSAGENS_POR_TURNO = 15;

/** Quantas saídas recentes se olham procurando a fronteira (automáticas são poucas por dia; isto cobre semanas). */
const SAIDAS_EXAMINADAS = 200;

/**
 * Quem mandou a última mensagem que conta como resposta nossa: o agente (`bastidor`), alguém da equipe pelo aparelho
 * ou pela tela (`humana`), ou ninguém ainda (`nenhuma`).
 */
export type UltimaRespostaNossa = 'bastidor' | 'humana' | 'nenhuma';

export interface MensagensDoTurno {
  /** O que ela escreveu desde a fronteira, em ordem (rajada junta). Vazio = nada a ler. */
  texto: string;
  /** Quando ela mandou a ÚLTIMA dessas mensagens. É até aqui que a validade do resumo é medida. */
  respondeuEm: Date | null;
  ultimaRespostaNossa: UltimaRespostaNossa;
}

/**
 * O resumo ainda espera o "sim"? É desta secretaria e desta organização, está `lido`, foi criado há menos de
 * `validadeHoras`, e ela não escreveu NADA na conversa depois dele (se escreveu — inclusive um "sim" cujo turno
 * falhou —, cobrar a confirmação seria cobrar o que ela já fez). Guarda do lembrete "falta só você confirmar".
 */
export async function resumoAindaEsperaOSim(
  pool: pg.Pool,
  a: { tenantId: string; contactId: string; relatoId: string; conversationId: string; agora: Date; validadeHoras: number },
): Promise<boolean> {
  const { rows } = await pool.query<{ aguardando: boolean }>(
    `select (r.estado = 'lido'
             and r.created_at > $4::timestamptz - make_interval(hours => $5::int)
             and not exists (
               select 1 from messages m
                where m.organization_id = r.organization_id and m.conversation_id = $6
                  and m.direction = 'inbound' and coalesce(m.sent_at, m.created_at) > r.created_at
             )) as aguardando
       from agenda_relatos r
      where r.organization_id = $1 and r.contact_id = $2 and r.id = $3`,
    [a.tenantId, a.contactId, a.relatoId, a.agora.toISOString(), a.validadeHoras, a.conversationId],
  );
  return rows[0]?.aguardando === true;
}

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export async function lerMensagensDesdeAUltimaResposta(
  pool: pg.Pool,
  tenantId: string,
  conversationId: string,
): Promise<MensagensDoTurno> {
  const { rows: fronteira } = await pool.query<{ quando: Date; job_kind: string | null }>(
    `with saidas as (
       select coalesce(m.sent_at, m.created_at) as quando, m.created_at,
              m.metadata->>'idempotency_key' as chave
         from messages m
        where m.organization_id = $1 and m.conversation_id = $2 and m.direction = 'outbound'
          and m.status is distinct from 'failed'
        order by quando desc, m.created_at desc
        limit ${SAIDAS_EXAMINADAS}
     ),
     classificadas as (
       select s.quando, s.created_at, j.kind as job_kind, j.payload->>'acao' as acao
         from saidas s
         left join send_ledger l
           on l.organization_id = $1
          and l.id = (case when s.chave ~ '${UUID}' then s.chave::uuid end)
         left join job_queue j on j.id = l.job_id
     )
     select quando, job_kind from classificadas
      where not coalesce(job_kind = 'bastidor_turn' and acao = any($3::text[]), false)
      order by quando desc, created_at desc
      limit 1`,
    [tenantId, conversationId, [...ACOES_AUTOMATICAS_DA_AGENDA]],
  );
  const limite = fronteira[0];

  const { rows } = await pool.query<{ body: string | null; media_derived_text: string | null; quando: Date }>(
    `select body, media_derived_text, quando from (
       select body, media_derived_text, coalesce(sent_at, created_at) as quando, created_at
         from messages
        where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
          and coalesce(sent_at, created_at) > coalesce($3::timestamptz, 'epoch'::timestamptz)
        order by quando desc, created_at desc
        limit $4
     ) recentes
     order by quando asc, created_at asc`,
    [tenantId, conversationId, limite?.quando ?? null, MAXIMO_DE_MENSAGENS_POR_TURNO],
  );

  const ultima = rows.at(-1);
  return {
    texto: rows
      .map((r) => (r.body ?? '').trim() || (r.media_derived_text ?? '').trim())
      .filter((t) => t !== '')
      .join('\n'),
    respondeuEm: ultima ? new Date(ultima.quando) : null,
    // Com ledger = saiu pelo agente (o job existe: a FK do ledger é `on delete cascade`). Sem ledger = alguém da equipe.
    ultimaRespostaNossa: limite === undefined ? 'nenhuma' : limite.job_kind !== null ? 'bastidor' : 'humana',
  };
}
