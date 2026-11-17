/**
 * A CONVERSA DA RESERVA DE HORÁRIO no worker — liga `lib/bastidor/secretaria/reservas-turno.ts` ao mundo.
 *
 * Três coisas chegam aqui, todas pelo job `bastidor_turn`:
 *
 *  - `perguntar_reserva`: a IA segurou um horário para um paciente e agora PERGUNTA à secretaria (texto fixo);
 *  - a mensagem dela, "sim" ou "não", quando há uma pergunta de reserva em aberto (`tratarRespostaDaReserva`);
 *  - `avisar_paciente_reserva`: o cron fechou a reserva por falta de resposta (`expirada`) e pede o aviso ao paciente.
 *
 * O roteiro está em `reservas-turno.ts`, sem banco e sem canal. Aqui só se ligam as portas: o cliente administrativo
 * para a reserva e o compromisso, a cadeia de guardrails (`bastidor-envio.ts`) para tudo que sai, e a Central de
 * avisos para o que um humano precisa saber (paciente que não pôde ser avisado, ninguém com horário parecido).
 *
 * ## Uma pergunta por vez
 *
 * A secretaria responde "sim"/"não" sem dizer a QUAL pedido se refere. Para esse "sim" ter um só significado, só há
 * uma pergunta de reserva em aberto por organização; a próxima sai quando a anterior fecha (resposta ou vencimento) —
 * `perguntarAProxima` — e o cron reenfileira o que se perder pelo caminho.
 */
import { z } from 'zod';
import type pg from 'pg';

import { marcarAgendamentoHandler } from '@/app/api/v1/agenda/agendamentos/_handler';
import { conversaDoContato, enfileirarTrabalhoDaReserva } from '@/lib/agenda/secretaria/conversa';
import {
  escolherHorariosParecidos,
  fecharReserva,
  lerReserva,
  ligarReservaAoCompromisso,
  marcarPacienteAvisado,
  marcarReservaPerguntada,
  proximaReservaAPerguntar,
  reabrirReserva,
  reservaValeAinda,
  reverterConfirmacao,
  VALIDADE_DA_RESERVA_MIN,
  type Reserva,
} from '@/lib/agenda/secretaria/reservas';
import { horariosLivresDaOrg } from '@/lib/agenda/consulta';
import { ApiError } from '@/lib/api/types';
import { perguntaDaReserva } from '@/lib/bastidor/secretaria/reservas-textos';
import {
  responderAoPedidoDeReserva,
  vencerReserva,
  type PortasDaReserva,
} from '@/lib/bastidor/secretaria/reservas-turno';

import type { ChannelAdapter } from '../channel-adapter';
import { WahaChannelAdapter } from '../edge/channel/waha-adapter';
import { enviarAoBastidor, enviarAoPaciente, fusoDaAgenda, type Registro } from './bastidor-envio';
import type { InboundTurnDeps } from './inbound-turn';

/** O trabalho de reserva que o cron ou a ferramenta enfileiram. Não nasce de mensagem dela. */
export const trabalhoDaReservaPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    acao: z.enum(['perguntar_reserva', 'avisar_paciente_reserva']),
    reserva_id: z.string().uuid(),
  })
  .passthrough();

/** Quanto tempo à frente se procura horário parecido para oferecer. */
const DIAS_PARA_PROCURAR_ALTERNATIVA = 14;

/** O autor do compromisso criado no "sim": o motor, em nome da recepção. */
const AUTOR_DA_MARCACAO = { type: 'ai_agent', id: 'agent-engine', role: 'ai_operator' } as const;

export interface ContextoDaReserva {
  pool: pg.Pool;
  deps: InboundTurnDeps;
  log: Registro;
  tenantId: string;
  /** A secretaria (contato do job). */
  secretariaId: string;
  conversationId: string;
  channelSessionId: string;
  jobId: string;
  fusoDaOrg: string | null;
  agora: Date;
}

const canalDe = (c: ContextoDaReserva): ChannelAdapter =>
  (c.deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, c.deps.crmCfg)))(c.pool);

/** Chama a equipe pela Central de avisos. Um aviso aberto por (paciente, título): o replay não empilha. */
async function chamarAEquipe(
  c: ContextoDaReserva,
  pacienteId: string,
  aviso: { titulo: string; corpo: string },
): Promise<void> {
  await c.pool.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, 'agenda_sem_resposta', 'warn', $2, $3, 'contacts', $4
      where not exists (
        select 1 from agent_inbox_items
         where organization_id = $1 and kind = 'agenda_sem_resposta' and status = 'open'
           and ref_kind = 'contacts' and ref_id = $4 and title = $2)`,
    [c.tenantId, aviso.titulo, aviso.corpo, pacienteId],
  );
}

function portasDaReserva(c: ContextoDaReserva, reserva: Reserva, fuso: string): PortasDaReserva {
  const admin = c.deps.crmCfg.supabase;
  const canal = canalDe(c);

  return {
    agora: c.agora,
    fuso,
    reserva,

    fechar: (status) => fecharReserva(admin, c.tenantId, reserva.id, status, c.agora),

    marcar: async (r) => {
      try {
        const criado = await marcarAgendamentoHandler(
          admin,
          { organization_id: c.tenantId, actor: AUTOR_DA_MARCACAO, requestId: c.jobId },
          {
            event_type_id: r.eventTypeId,
            starts_at: r.inicio.toISOString(),
            contact_id: r.contactId,
            owner_user_id: r.ownerUserId,
            notes: `Confirmado pela recepção pelo WhatsApp. Nome informado: ${r.nomePaciente}.${r.notas ? ` ${r.notas}` : ''}`,
            ignorar_reserva_id: r.id,
          },
        );
        return { ok: true, appointmentId: String(criado.id) };
      } catch (e) {
        // Recusa de NEGÓCIO (horário tomado, jornada, tipo desativado): a confirmação não vale.
        if (e instanceof ApiError) {
          c.log.warn('reserva: o compromisso não pôde ser marcado', { codigo: e.code });
          return { ok: false };
        }
        // Falha de infraestrutura: nada foi marcado e nada foi dito a ninguém. Reabre a reserva para o replay do job
        // (a resposta dela continua sendo a última mensagem) e deixa o job tentar de novo.
        await reabrirReserva(admin, c.tenantId, r.id);
        throw e;
      }
    },
    ligarAoCompromisso: (appointmentId) => ligarReservaAoCompromisso(admin, c.tenantId, reserva.id, appointmentId),
    // Recusada: o horário não existe mais (a reserva já estava `confirmada`).
    reverter: () => reverterConfirmacao(admin, c.tenantId, reserva.id),

    horariosParecidos: async (r) => {
      const consulta = await horariosLivresDaOrg(admin, c.tenantId, {
        eventTypeId: r.eventTypeId,
        ownerUserId: r.ownerUserId,
        de: c.agora,
        ate: new Date(c.agora.getTime() + DIAS_PARA_PROCURAR_ALTERNATIVA * 86_400_000),
        agora: c.agora,
        // Mesma régua da IA: só oferece o que a agenda conferida recentemente sustenta.
        exigirAgendaConferida: true,
      });
      if (!consulta.ok || !consulta.publicouHorarios) return [];
      return escolherHorariosParecidos(consulta.slots, r.inicio, consulta.fusoDaRegra, c.agora, 2);
    },

    avisarPaciente: async (texto) => {
      const conversa = await conversaDoContato(admin, c.tenantId, reserva.contactId);
      const falhou = (porque: string) =>
        chamarAEquipe(c, reserva.contactId, {
          titulo: `Avise ${reserva.nomePaciente}: a IA não conseguiu falar com ele`,
          corpo: `A IA tentou avisar ${reserva.nomePaciente} (${porque}). O que ela queria dizer: "${texto}"`,
        });
      if (conversa === null) {
        await falhou('sem conversa aberta');
        return;
      }
      const desfecho = await enviarAoPaciente({
        pool: c.pool,
        channel: canal,
        deps: c.deps,
        log: c.log,
        tenantId: c.tenantId,
        pacienteId: reserva.contactId,
        jobId: c.jobId,
        conversationId: conversa.conversationId,
        channelSessionId: conversa.channelSessionId,
        corpo: texto,
        agora: c.agora,
      });
      if (!desfecho.enviado) {
        await falhou(desfecho.porque);
        return;
      }
      await marcarPacienteAvisado(admin, c.tenantId, reserva.id, c.agora);
    },

    avisarSecretaria: async (texto) => {
      await enviarAoBastidor({
        pool: c.pool,
        channel: canal,
        deps: c.deps,
        log: c.log,
        tenantId: c.tenantId,
        leadId: c.secretariaId,
        jobId: c.jobId,
        conversationId: c.conversationId,
        channelSessionId: c.channelSessionId,
        corpo: texto,
        tipo: 'reserva_aviso',
        agora: c.agora,
      });
    },

    avisarEquipe: (aviso) => chamarAEquipe(c, reserva.contactId, aviso),
  };
}

/** Depois que uma reserva fecha, a próxima da fila é perguntada (uma pergunta por vez). */
async function perguntarAProxima(c: ContextoDaReserva): Promise<void> {
  const admin = c.deps.crmCfg.supabase;
  const proxima = await proximaReservaAPerguntar(admin, c.tenantId, c.agora);
  if (proxima === null) return;
  await enfileirarTrabalhoDaReserva(
    admin,
    c.tenantId,
    { contactId: c.secretariaId, conversationId: c.conversationId, channelSessionId: c.channelSessionId },
    'perguntar_reserva',
    proxima.id,
  );
}

/** A secretaria respondeu "sim" ou "não" à pergunta de reserva em aberto. */
export async function tratarRespostaDaReserva(
  c: ContextoDaReserva,
  reserva: Reserva,
  resposta: 'sim' | 'nao',
): Promise<void> {
  const fuso = await fusoDaAgenda(c.pool, c.tenantId, reserva.ownerUserId, c.fusoDaOrg);
  const desfecho = await responderAoPedidoDeReserva(portasDaReserva(c, reserva, fuso), resposta);
  c.log.info('reserva: resposta da secretaria tratada', { acao: desfecho.acao });
  await perguntarAProxima(c);
}

/** Os dois trabalhos que o cron/ferramenta enfileiram (não nascem de mensagem dela). */
export async function executarTrabalhoDaReserva(
  c: ContextoDaReserva,
  pedido: z.infer<typeof trabalhoDaReservaPayloadSchema>,
): Promise<void> {
  const admin = c.deps.crmCfg.supabase;
  const reserva = await lerReserva(admin, c.tenantId, pedido.reserva_id);
  if (reserva === null) {
    c.log.info('reserva: trabalho de reserva inexistente — nada a fazer', { reserva_id: pedido.reserva_id });
    return;
  }
  const fuso = await fusoDaAgenda(c.pool, c.tenantId, reserva.ownerUserId, c.fusoDaOrg);

  if (pedido.acao === 'avisar_paciente_reserva') {
    // O cron já fechou a reserva como `expirada`. Qualquer outro estado = outra via (resposta dela) já tratou.
    if (reserva.status !== 'expirada') {
      c.log.info('reserva: aviso de vencimento dispensado — a reserva não está expirada', { status: reserva.status });
      return;
    }
    const desfecho = await vencerReserva(portasDaReserva(c, reserva, fuso));
    c.log.info('reserva: vencimento tratado', { acao: desfecho.acao });
    await perguntarAProxima(c);
    return;
  }

  // perguntar_reserva
  if (!reservaValeAinda(reserva, c.agora)) {
    c.log.info('reserva: pergunta dispensada — a reserva já fechou ou venceu', { status: reserva.status });
    return;
  }
  // Uma pergunta por vez: se outra está aberta, esta sai quando aquela fechar (`perguntarAProxima`) ou pelo cron.
  const proxima = await proximaReservaAPerguntar(admin, c.tenantId, c.agora);
  if (proxima === null || proxima.id !== reserva.id) {
    c.log.info('reserva: pergunta adiada — há outra pergunta em aberto', { reserva_id: reserva.id });
    return;
  }
  if (!(await marcarReservaPerguntada(admin, c.tenantId, reserva.id, c.agora))) {
    c.log.info('reserva: pergunta já feita — replay do job', { reserva_id: reserva.id });
    return;
  }
  await enviarAoBastidor({
    pool: c.pool,
    channel: canalDe(c),
    deps: c.deps,
    log: c.log,
    tenantId: c.tenantId,
    leadId: c.secretariaId,
    jobId: c.jobId,
    conversationId: pedido.conversation_id,
    channelSessionId: pedido.channel_session_id,
    corpo: perguntaDaReserva({
      nomePaciente: reserva.nomePaciente,
      inicio: reserva.inicio,
      fuso,
      minutos: VALIDADE_DA_RESERVA_MIN,
    }),
    tipo: 'reserva_pergunta',
    agora: c.agora,
  });
}
