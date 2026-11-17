/**
 * Handler do job `bastidor_turn` — a IA conversando com a EQUIPE (migration 0229).
 *
 * Quem tem `contacts.papel_interno` (0227) nunca é atendido pelo agente de vendas. A mensagem dele chega aqui, por
 * um tipo de job próprio que o drain cria no lugar do `inbound_turn`. Hoje o único papel com conversa é a
 * SECRETARIA (agenda); o Marketing entra na versão seguinte e, até lá, o drain nem enfileira.
 *
 * ## Este arquivo é só o encanamento
 *
 * O roteiro (relato novo, "sim", correção, dúvida) mora em `lib/bastidor/secretaria/turno.ts`, sem banco nem
 * modelo, e é testado com portas de mentira. Aqui as portas são ligadas de verdade:
 *
 *  - ler as mensagens dela desde a última resposta nossa (rajada de mensagens = um turno só);
 *  - ler o resumo que está esperando conferência;
 *  - chamar o modelo para LER o texto (nunca para responder: toda resposta é texto fixo em `textos.ts`);
 *  - gravar/aplicar o relato (`lib/agenda/secretaria/relatos.ts`);
 *  - enviar PELA MESMA cadeia de guardrails de tudo que sai (`runBeforeSend`), declarando `bastidor`, que é a
 *    única porta aberta para um contato fora do funil.
 *
 * ## Defesa em profundidade
 *
 * O drain já só enfileira para quem tem papel, mas o papel é RELIDO aqui, do banco: um job antigo de um contato
 * que perdeu o papel (ou foi bloqueado) vira no-op, não uma conversa. E a secretaria ligada é checada a cada job:
 * `settings.secretaria.ativa` é falso por padrão e nenhuma organização muda de comportamento sem ligar.
 */
import { z } from 'zod';
import type pg from 'pg';

import { lerConfigDaSecretaria } from '@/lib/agenda/secretaria/config';
import {
  conferirEAplicarRelato,
  descartarRelato,
  marcarRelatoCorrigido,
  registrarRelato,
} from '@/lib/agenda/secretaria/relatos';
import { relatoLidoSchema } from '@/lib/agenda/secretaria/relato';
import { executarTurnoDaSecretaria, type Portas } from '@/lib/bastidor/secretaria/turno';
import type { TipoDeMensagemDoBastidor } from '@/lib/bastidor/papeis';

import type { ChannelAdapter } from '../channel-adapter';
import { WahaChannelAdapter } from '../edge/channel/waha-adapter';
import { runModelCall } from '../edge/llm/run-model-call';
import { runBeforeSend } from '../guardrails/before-send';
import { withFields } from '../obs/logger';
import type { JobRow } from '../queue/queue';
import type { InboundTurnDeps } from './inbound-turn';

export const bastidorTurnPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    inbound_message_id: z.string().uuid(),
  })
  .passthrough();

/** Fuso padrão quando nem a jornada do dono nem a organização dizem qual é. */
const FUSO_PADRAO = 'America/Sao_Paulo';
/** Quantas mensagens em rajada entram num turno. Mais que isso é conversa, não rajada. */
const MAXIMO_DE_MENSAGENS_POR_TURNO = 15;

/**
 * Uma resposta por turno: `seq 1`. O ledger deduplica por (job, seq), então o replay de um job que caiu depois de
 * enviar não manda a mesma resposta duas vezes.
 */
const SEQ_DA_RESPOSTA = 1;

interface LinhaDoContato {
  papel_interno: string | null;
  is_blocked: boolean;
  is_anonymized: boolean;
}

export function createBastidorTurnHandler(deps: InboundTurnDeps) {
  return async function handleBastidorTurn(
    job: JobRow,
    pool: pg.Pool,
    _ctx: { workerId: string },
  ): Promise<void> {
    const tenantId = job.organization_id;
    const leadId = job.contact_id;
    if (leadId === null) {
      throw new Error('bastidor_turn sem contact_id — o CHECK da fila deveria impedir');
    }
    const payload = bastidorTurnPayloadSchema.parse(job.payload);
    const log = withFields(deps.log, { job_id: job.id, tenant_id: tenantId, contact_id: leadId });
    const agora = (deps.clock ?? (() => new Date()))();

    // O papel é relido do banco: o job pode ser antigo e o contato ter mudado.
    const { rows: contatoRows } = await pool.query<LinhaDoContato>(
      `select papel_interno, is_blocked, is_anonymized from contacts where organization_id = $1 and id = $2`,
      [tenantId, leadId],
    );
    const contato = contatoRows[0];
    if (contato === undefined || contato.papel_interno !== 'secretaria') {
      log.info('bastidor: contato sem o papel de secretaria — nada a fazer', { papel: contato?.papel_interno ?? null });
      return;
    }
    if (contato.is_blocked || contato.is_anonymized) {
      log.info('bastidor: contato bloqueado ou anonimizado — nada a fazer');
      return;
    }

    const { rows: orgRows } = await pool.query<{ timezone: string | null; settings: unknown }>(
      `select timezone, settings from organizations where id = $1`,
      [tenantId],
    );
    const config = lerConfigDaSecretaria(orgRows[0]?.settings);
    if (!config.ativa) {
      log.info('bastidor: secretaria não está ativada nesta organização — mensagem não tratada');
      return;
    }

    const fuso = await fusoDaAgenda(pool, tenantId, config.dono_da_agenda_user_id, orgRows[0]?.timezone ?? null);
    const texto = await lerMensagensDesdeAUltimaResposta(pool, tenantId, payload.conversation_id);
    const pendente = await lerResumoPendente(pool, tenantId, leadId);
    const jaRegistrado = await lerRelatoDestaMensagem(pool, tenantId, payload.inbound_message_id);

    const admin = deps.crmCfg.supabase;
    const channel: ChannelAdapter = (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, deps.crmCfg)))(pool);

    const portas: Portas = {
      agora,
      fuso,
      texto,
      pendente,
      jaRegistrado,
      lerComModelo: async (prompt) => {
        const { result } = await runModelCall(
          pool,
          deps.llmCfg,
          {
            tenantId,
            leadId,
            jobId: job.id,
            // Ponto de IA próprio (`lib/ai/pontos/registro.ts`): quem paga vê esta leitura na tela de execuções.
            purpose: 'bastidor_leitura',
            messages: [{ role: 'user', content: prompt }],
          },
          { log, ...(deps.registry !== undefined ? { registry: deps.registry } : {}) },
        );
        return result.text;
      },
      registrar: (lido, textoBruto) =>
        registrarRelato(admin, {
          organizationId: tenantId,
          contactId: leadId,
          messageId: payload.inbound_message_id,
          texto: textoBruto,
          lido,
        }),
      conferir: (relatoId) => conferirEAplicarRelato(admin, { organizationId: tenantId, relatoId, agora }),
      marcarCorrigido: (relatoId) => marcarRelatoCorrigido(admin, { organizationId: tenantId, relatoId }),
      descartar: (relatoId) => descartarRelato(admin, { organizationId: tenantId, relatoId }),
      enviar: (corpo) =>
        enviarAoBastidor({
          pool,
          channel,
          deps,
          log,
          tenantId,
          leadId,
          jobId: job.id,
          conversationId: payload.conversation_id,
          channelSessionId: payload.channel_session_id,
          corpo,
          tipo: 'agenda_conferencia',
          agora,
        }),
    };

    const desfecho = await executarTurnoDaSecretaria(portas);
    log.info('bastidor: turno da secretaria concluído', { acao: desfecho.acao });
  };
}

/** O fuso da agenda: o da jornada do dono; senão o da organização; senão o padrão. */
async function fusoDaAgenda(
  pool: pg.Pool,
  tenantId: string,
  donoUserId: string | null,
  fusoDaOrg: string | null,
): Promise<string> {
  if (donoUserId !== null) {
    const { rows } = await pool.query<{ tz: string | null }>(
      `select schedule->>'timezone' as tz from attendant_availability where organization_id = $1 and user_id = $2`,
      [tenantId, donoUserId],
    );
    const tz = rows[0]?.tz;
    if (typeof tz === 'string' && tz.trim() !== '') return tz;
  }
  return fusoDaOrg ?? FUSO_PADRAO;
}

/**
 * O que ela escreveu desde a última coisa que NÓS enviamos nesta conversa, em ordem. É o que faz duas mensagens
 * seguidas ("terça 14h Maria" / "e 15h João") serem lidas juntas: o drain pula o evento superado e o turno da
 * última lê as duas. Áudio entra pela transcrição.
 */
async function lerMensagensDesdeAUltimaResposta(
  pool: pg.Pool,
  tenantId: string,
  conversationId: string,
): Promise<string> {
  const { rows } = await pool.query<{ body: string | null; media_derived_text: string | null }>(
    `select body, media_derived_text from (
       select body, media_derived_text, coalesce(sent_at, created_at) as quando, created_at
         from messages
        where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
          and coalesce(sent_at, created_at) > coalesce(
                (select max(coalesce(sent_at, created_at)) from messages
                  where organization_id = $1 and conversation_id = $2 and direction = 'outbound'),
                'epoch'::timestamptz)
        order by quando desc, created_at desc
        limit $3
     ) recentes
     order by quando asc, created_at asc`,
    [tenantId, conversationId, MAXIMO_DE_MENSAGENS_POR_TURNO],
  );
  return rows
    .map((r) => (r.body ?? '').trim() || (r.media_derived_text ?? '').trim())
    .filter((t) => t !== '')
    .join('\n');
}

/** O resumo mais recente que ainda espera o "sim" (estado `lido`). */
async function lerResumoPendente(
  pool: pg.Pool,
  tenantId: string,
  contactId: string,
): Promise<Portas['pendente']> {
  const { rows } = await pool.query<{ id: string; lido: unknown; created_at: Date }>(
    `select id, lido, created_at from agenda_relatos
      where organization_id = $1 and contact_id = $2 and estado = 'lido'
      order by created_at desc limit 1`,
    [tenantId, contactId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  const lido = relatoLidoSchema.safeParse(r.lido);
  // Resumo ilegível não pode ser confirmado: tratar como inexistente (o texto novo vira relato novo).
  if (!lido.success) return null;
  return { id: r.id, lido: lido.data, criadoEm: new Date(r.created_at) };
}

/** O relato que ESTA mensagem já gerou (replay do job depois de registrar e antes de enviar). */
async function lerRelatoDestaMensagem(
  pool: pg.Pool,
  tenantId: string,
  messageId: string,
): Promise<Portas['jaRegistrado']> {
  const { rows } = await pool.query<{ id: string; estado: string; lido: unknown }>(
    `select id, estado, lido from agenda_relatos where organization_id = $1 and message_id = $2`,
    [tenantId, messageId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  const lido = relatoLidoSchema.safeParse(r.lido);
  return lido.success ? { id: r.id, estado: r.estado, lido: lido.data } : null;
}

interface EnvioDoBastidor {
  pool: pg.Pool;
  channel: ChannelAdapter;
  deps: InboundTurnDeps;
  log: ReturnType<typeof withFields>;
  tenantId: string;
  leadId: string;
  jobId: string;
  conversationId: string;
  channelSessionId: string;
  corpo: string;
  tipo: TipoDeMensagemDoBastidor;
  agora: Date;
}

/**
 * Envia pela cadeia de guardrails, declarando `bastidor` (a única porta para um contato fora do funil).
 *
 * `enforceSpinning: false`: o gate de repetição existe para barrar rajada de texto quase igual a MUITOS contatos
 * (blast). Aqui é uma pessoa só da equipe, e as respostas são fixas por desenho ("Sem problema! O que está
 * diferente?" duas vezes no mesmo dia é o comportamento certo, não spam). O bastidor também fica FORA do limite diário: a cadeia não aplica o
 * teto de warm-up/diário a ele e `recordSend` não o conta, então a equipe não gasta a cota das vendas (janela
 * horária e espaçamento continuam valendo).
 *
 * Veto da cadeia NÃO é erro do job: registra e segue. Retentar não muda o veredito (janela, opt-out), e o job
 * morto geraria alerta crítico por algo que é decisão de negócio.
 */
async function enviarAoBastidor(e: EnvioDoBastidor): Promise<void> {
  const chain = await runBeforeSend({
    pool: e.pool,
    log: e.log,
    tenantId: e.tenantId,
    leadId: e.leadId,
    jobId: e.jobId,
    channelSessionId: e.channelSessionId,
    body: e.corpo,
    optedOutThisTurn: false,
    bastidor: { tipo: e.tipo },
    enforceSpinning: false,
    // Mesmo débito declarado nos outros caminhos: o limite diário do CRM ainda não é lido no runtime.
    crmDailyLimit: null,
    now: e.agora,
    ...(e.deps.sleep !== undefined ? { sleep: e.deps.sleep } : {}),
    send: (finalBody) =>
      e.channel.send({
        tenantId: e.tenantId,
        leadId: e.leadId,
        jobId: e.jobId,
        seq: SEQ_DA_RESPOSTA,
        conversationId: e.conversationId,
        body: finalBody,
      }),
  });

  if (chain.status === 'vetoed') {
    e.log.warn('bastidor: resposta à secretaria vetada pela cadeia', { gate: chain.gate, code: chain.code });
    return;
  }
  e.log.info('bastidor: resposta enviada', { resultado: chain.outcome.kind });
}
