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

import { RelatoIncoerente } from '@/lib/agenda/secretaria/aplicar';
import { lerConfigDaSecretaria } from '@/lib/agenda/secretaria/config';
import {
  conferirEAplicarRelato,
  descartarRelato,
  marcarRelatoCorrigido,
  registrarRelato,
} from '@/lib/agenda/secretaria/relatos';
import { relatoLidoSchema } from '@/lib/agenda/secretaria/relato';
import { reservaEmPerguntaAberta } from '@/lib/agenda/secretaria/reservas';
import { TOLERANCIA_DA_PERGUNTA_MIN } from '@/lib/bastidor/secretaria/perguntas';
import { interpretarRespostaDeConferencia } from '@/lib/bastidor/secretaria/resposta';
import {
  TEXTO_DO_LEMBRETE_DA_CONFERENCIA,
  TEXTO_DO_LEMBRETE_DA_PERGUNTA,
  textoDaPergunta,
} from '@/lib/bastidor/secretaria/textos';
import { executarTurnoDaSecretaria, VALIDADE_DO_RESUMO_HORAS, type Portas } from '@/lib/bastidor/secretaria/turno';

import type { ChannelAdapter } from '../channel-adapter';
import { WahaChannelAdapter } from '../edge/channel/waha-adapter';
import { runModelCall } from '../edge/llm/run-model-call';
import { withFields } from '../obs/logger';
import { PREFIXO_DA_AGENDA_NAO_APLICADA, type JobRow } from '../queue/queue';
import { enviarAoBastidor, fusoDaAgenda } from './bastidor-envio';
import { lerMensagensDesdeAUltimaResposta, resumoAindaEsperaOSim } from './bastidor-mensagens';
import {
  executarTrabalhoDaReserva,
  tratarRespostaDaReserva,
  trabalhoDaReservaPayloadSchema,
  type ContextoDaReserva,
} from './bastidor-reserva';
import type { InboundTurnDeps } from './inbound-turn';

export const bastidorTurnPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    inbound_message_id: z.string().uuid(),
  })
  .passthrough();

/**
 * O job que NÃO nasce de uma mensagem dela: o cron das perguntas diárias (`secretaria-agenda`) pede à IA que PERGUNTE
 * a agenda num horário, ou LEMBRE (uma vez) da pergunta que ficou sem resposta. Não há `inbound_message_id`.
 */
export const perguntaDaAgendaPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    acao: z.enum(['perguntar', 'lembrar']),
    dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    horario: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .passthrough();

/**
 * O job do cron que LEMBRA a secretaria de confirmar um resumo que espera o "sim" (no lugar da pergunta diária;
 * `perguntas-tick.ts`). Um por resumo: o cron o enfileira com `source_event_id` = id do relato.
 */
export const lembreteDaConferenciaPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    acao: z.literal('lembrar_conferencia'),
    relato_id: z.string().uuid(),
  })
  .passthrough();

/** Pergunta que esperou na fila mais que isto (worker parado) não vale mais: "bom dia" às 15h é fora de propósito. */
const VALIDADE_DO_PEDIDO_DE_PERGUNTA_MS = TOLERANCIA_DA_PERGUNTA_MIN * 60_000;

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
    // Quatro formatos de job: o que nasce de uma mensagem dela, o do cron das perguntas diárias, o lembrete de
    // confirmar o resumo (também do cron) e o da reserva de horário.
    const pedidoDePergunta = perguntaDaAgendaPayloadSchema.safeParse(job.payload);
    const trabalhoDeReserva = pedidoDePergunta.success ? null : trabalhoDaReservaPayloadSchema.safeParse(job.payload);
    const lembreteDaConferencia =
      pedidoDePergunta.success || trabalhoDeReserva?.success === true
        ? null
        : lembreteDaConferenciaPayloadSchema.safeParse(job.payload);
    const payloadDeMensagem =
      pedidoDePergunta.success || trabalhoDeReserva?.success === true || lembreteDaConferencia?.success === true
        ? null
        : bastidorTurnPayloadSchema.parse(job.payload);
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

    if (pedidoDePergunta.success) {
      await tratarPerguntaDaAgenda({
        pool,
        deps,
        log,
        tenantId,
        leadId,
        jobId: job.id,
        jobCriadoEm: new Date(job.created_at),
        pedido: pedidoDePergunta.data,
        agora,
      });
      return;
    }
    if (lembreteDaConferencia?.success === true) {
      await tratarLembreteDaConferencia({
        pool,
        deps,
        log,
        tenantId,
        leadId,
        jobId: job.id,
        jobCriadoEm: new Date(job.created_at),
        pedido: lembreteDaConferencia.data,
        agora,
      });
      return;
    }
    // Contexto da reserva de horário: o mesmo para o trabalho enfileirado e para a resposta dela.
    const contextoDaReserva = (conversationId: string, channelSessionId: string): ContextoDaReserva => ({
      pool,
      deps,
      log,
      tenantId,
      secretariaId: leadId,
      conversationId,
      channelSessionId,
      jobId: job.id,
      fusoDaOrg: orgRows[0]?.timezone ?? null,
      agora,
    });

    if (trabalhoDeReserva?.success === true) {
      await executarTrabalhoDaReserva(
        contextoDaReserva(trabalhoDeReserva.data.conversation_id, trabalhoDeReserva.data.channel_session_id),
        trabalhoDeReserva.data,
      );
      return;
    }

    const payload = payloadDeMensagem;
    if (payload === null) throw new Error('bastidor_turn: payload nem de pergunta nem de mensagem — inalcançável');

    const fuso = await fusoDaAgenda(pool, tenantId, config.dono_da_agenda_user_id, orgRows[0]?.timezone ?? null);
    // Rajada junta ("terça 14h Maria" / "e 15h João"): o drain pula o evento superado e o turno da última lê as duas.
    // A fronteira ignora as mensagens AUTOMÁTICAS de agenda (ver `bastidor-mensagens.ts`): o "sim" dado antes de um
    // lembrete do cron não se perde.
    const { texto, respondeuEm, ultimaRespostaNossa } = await lerMensagensDesdeAUltimaResposta(
      pool,
      tenantId,
      payload.conversation_id,
    );
    const pendente = await lerResumoPendente(pool, tenantId, leadId);
    const jaRegistrado = await lerRelatoDestaMensagem(pool, tenantId, payload.inbound_message_id);

    const admin = deps.crmCfg.supabase;

    // Uma pergunta de RESERVA em aberto tem prioridade sobre o resumo da agenda quando o "sim"/"não" dela veio DEPOIS
    // da pergunta de reserva — o mais recente é a que ela está respondendo. Qualquer outra coisa (inclusive "sim, mas…")
    // segue o caminho de sempre e a reserva continua esperando até vencer: só o "sim" inequívoco marca um horário.
    const reservaAberta = await reservaEmPerguntaAberta(admin, tenantId);
    if (reservaAberta?.perguntadaEm != null) {
      const resposta = interpretarRespostaDeConferencia(texto);
      const reservaEhAMaisRecente =
        pendente === null || reservaAberta.perguntadaEm.getTime() > pendente.criadoEm.getTime();
      if ((resposta === 'sim' || resposta === 'nao') && reservaEhAMaisRecente) {
        await tratarRespostaDaReserva(
          contextoDaReserva(payload.conversation_id, payload.channel_session_id),
          reservaAberta,
          resposta,
        );
        return;
      }
    }
    const channel: ChannelAdapter = (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, deps.crmCfg)))(pool);

    const portas: Portas = {
      agora,
      fuso,
      texto,
      respondeuEm,
      ultimaRespostaNossa,
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
      // A falha ao aplicar o "sim" PROPAGA (o job tenta de novo), mas com a mensagem que o dono entende: se as
      // tentativas acabarem, o aviso da Central diz "A agenda que a secretária confirmou não foi aplicada. Motivo: …"
      // (ver `PREFIXO_DA_AGENDA_NAO_APLICADA` em queue.ts). "Dono não definido" segue cru: o turno responde a ela.
      conferir: async (relatoId) => {
        try {
          return await conferirEAplicarRelato(admin, { organizationId: tenantId, relatoId, agora });
        } catch (err) {
          if (err instanceof Error && err.message === 'dono_da_agenda_nao_definido') throw err;
          log.warn('bastidor: a agenda confirmada não foi aplicada — o job vai tentar de novo', {
            motivo: motivoDaFalhaDaConferencia(err),
          });
          throw new Error(`${PREFIXO_DA_AGENDA_NAO_APLICADA} Motivo: ${motivoDaFalhaDaConferencia(err)}`, {
            cause: err,
          });
        }
      },
      marcarCorrigido: (relatoId) => marcarRelatoCorrigido(admin, { organizationId: tenantId, relatoId }),
      descartar: (relatoId) => descartarRelato(admin, { organizationId: tenantId, relatoId }),
      // Veto da cadeia não é erro (ver `enviarAoBastidor`): o desfecho do envio não muda o roteiro do turno.
      enviar: async (corpo) => {
        await enviarAoBastidor({
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
        });
      },
    };

    const desfecho = await executarTurnoDaSecretaria(portas);
    log.info('bastidor: turno da secretaria concluído', { acao: desfecho.acao });
  };
}

interface PerguntaDaAgenda {
  pool: pg.Pool;
  deps: InboundTurnDeps;
  log: ReturnType<typeof withFields>;
  tenantId: string;
  leadId: string;
  jobId: string;
  jobCriadoEm: Date;
  pedido: z.infer<typeof perguntaDaAgendaPayloadSchema>;
  agora: Date;
}

/**
 * PERGUNTAR ou LEMBRAR a agenda (job criado pelo cron `secretaria-agenda`). Texto fixo (`textos.ts`), enviado pela
 * mesma cadeia de proteções, com o tipo `agenda_pergunta` ou `agenda_lembrete` — os únicos que a cadeia abre à
 * secretaria para uma mensagem que ELA não puxou.
 *
 * Duas guardas antes de enviar, porque o job pode ter esperado na fila:
 *  - pergunta velha demais (worker parado) não sai: "bom dia" às 15h seria fora de propósito;
 *  - lembrete de pergunta que ela já respondeu (carimbo, ou mensagem dela depois da pergunta) não sai.
 */
async function tratarPerguntaDaAgenda(a: PerguntaDaAgenda): Promise<void> {
  const { pool, deps, log, tenantId, leadId, pedido, agora } = a;

  if (agora.getTime() - a.jobCriadoEm.getTime() > VALIDADE_DO_PEDIDO_DE_PERGUNTA_MS) {
    log.info('bastidor: pedido de pergunta velho demais — não enviado', { acao: pedido.acao, horario: pedido.horario });
    return;
  }

  if (pedido.acao === 'lembrar') {
    const { rows } = await pool.query<{ respondeu: boolean }>(
      `select (p.respondida_em is not null) or exists (
                select 1 from messages m join conversations c on c.id = m.conversation_id
                 where c.organization_id = p.organization_id and c.contact_id = p.contact_id
                   and m.direction = 'inbound' and m.created_at >= p.pedida_em
              ) as respondeu
         from agenda_perguntas p
        where p.organization_id = $1 and p.contact_id = $2 and p.dia = $3 and p.horario = $4`,
      [tenantId, leadId, pedido.dia, pedido.horario],
    );
    if (rows[0] === undefined || rows[0].respondeu) {
      log.info('bastidor: lembrete dispensado — a pergunta já foi respondida ou não existe', { horario: pedido.horario });
      return;
    }
  }

  const channel: ChannelAdapter = (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, deps.crmCfg)))(pool);
  await enviarAoBastidor({
    pool,
    channel,
    deps,
    log,
    tenantId,
    leadId,
    jobId: a.jobId,
    conversationId: pedido.conversation_id,
    channelSessionId: pedido.channel_session_id,
    corpo: pedido.acao === 'perguntar' ? textoDaPergunta(pedido.horario) : TEXTO_DO_LEMBRETE_DA_PERGUNTA,
    tipo: pedido.acao === 'perguntar' ? 'agenda_pergunta' : 'agenda_lembrete',
    agora,
  });
}

interface LembreteDaConferencia extends Omit<PerguntaDaAgenda, 'pedido'> {
  pedido: z.infer<typeof lembreteDaConferenciaPayloadSchema>;
}

/**
 * LEMBRAR de confirmar o resumo (job do cron, um por resumo). Só sai se o resumo AINDA espera o "sim": o relato é
 * desta secretaria e desta organização, está `lido`, tem menos de 12 h, e ela não escreveu nada depois dele (se
 * escreveu — inclusive um "sim" cujo turno falhou —, lembrar seria cobrar o que ela já fez; quem cobre a falha é o
 * aviso na Central). Pedido velho na fila não sai, como a pergunta.
 */
async function tratarLembreteDaConferencia(a: LembreteDaConferencia): Promise<void> {
  const { pool, deps, log, tenantId, leadId, pedido, agora } = a;

  if (agora.getTime() - a.jobCriadoEm.getTime() > VALIDADE_DO_PEDIDO_DE_PERGUNTA_MS) {
    log.info('bastidor: lembrete do resumo velho demais na fila — não enviado');
    return;
  }

  const aguardando = await resumoAindaEsperaOSim(pool, {
    tenantId,
    contactId: leadId,
    relatoId: pedido.relato_id,
    conversationId: pedido.conversation_id,
    agora,
    validadeHoras: VALIDADE_DO_RESUMO_HORAS,
  });
  if (!aguardando) {
    log.info('bastidor: lembrete do resumo dispensado — o resumo não espera mais o "sim"');
    return;
  }

  const channel: ChannelAdapter = (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, deps.crmCfg)))(pool);
  await enviarAoBastidor({
    pool,
    channel,
    deps,
    log,
    tenantId,
    leadId,
    jobId: a.jobId,
    conversationId: pedido.conversation_id,
    channelSessionId: pedido.channel_session_id,
    corpo: TEXTO_DO_LEMBRETE_DA_CONFERENCIA,
    // O tipo AUTOMÁTICO: a leitura das mensagens dela não conta este lembrete como fronteira do turno.
    tipo: 'agenda_lembrete',
    agora,
  });
}

/**
 * Por que a agenda confirmada não foi aplicada, em português do dono do negócio. NUNCA leva nome de paciente: a
 * mensagem vai para `job_queue.last_error`, para o log e para a Central — por isso o relato incoerente (cuja mensagem
 * cita nomes) vira uma frase fixa, e o erro técnico entra só pela primeira linha, curta.
 */
export function motivoDaFalhaDaConferencia(err: unknown): string {
  if (err instanceof RelatoIncoerente) return 'o resumo tem horários contraditórios (ex.: alguém marcado num dia fechado).';
  const msg = err instanceof Error ? err.message : String(err);
  if (/sem_duplicata|duplicate key/i.test(msg)) {
    return 'a agenda recusou dois compromissos no mesmo horário do mesmo profissional.';
  }
  if (msg === 'relato_descartado' || msg === 'relato_corrigido') {
    return 'o resumo já tinha sido descartado ou corrigido antes do "sim" ser aplicado.';
  }
  if (msg === 'relato_nao_encontrado') return 'o resumo não foi encontrado.';
  if (msg === 'relato_ilegivel') return 'o resumo gravado está ilegível.';
  const primeira = (msg.split('\n', 1)[0] ?? '').slice(0, 160);
  return `erro ao gravar na agenda (${primeira}).`;
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
