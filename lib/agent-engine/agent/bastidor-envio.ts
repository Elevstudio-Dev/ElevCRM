/**
 * O ENVIO do agente de bastidor — a secretaria (e, na reserva de horário, o paciente).
 *
 * Tudo que o bastidor escreve passa pela MESMA cadeia de guardrails de qualquer mensagem (`runBeforeSend`); nada sai
 * por baixo dela. Este arquivo existe separado do handler (`bastidor-turn.ts`) porque dois handlers falam com o mundo
 * do mesmo jeito — o turno da secretaria e a conversa da reserva — e um importando o outro seria um ciclo.
 *
 * ## Dois destinatários, duas portas
 *
 * - A SECRETARIA é um contato da equipe fora do funil: só passa declarando `bastidor` (a única porta aberta a quem tem
 *   papel interno), e fica FORA do limite diário (a equipe não gasta a cota das vendas).
 * - O PACIENTE é um contato de vendas comum: passa pela cadeia INTEIRA, sem `bastidor`, com o limite diário valendo.
 *   Se a cadeia vetar (janela fechada, cap, opt-out), o chamador cai no aviso da equipe — o paciente nunca fica no
 *   escuro sem que alguém saiba.
 */
import type pg from 'pg';

import type { TipoDeMensagemDoBastidor } from '@/lib/bastidor/papeis';

import type { ChannelAdapter } from '../channel-adapter';
import { deriveLgpdFromContact, type LgpdInput } from '../guardrails/lgpd/legal-basis';
import { runBeforeSend } from '../guardrails/before-send';
import type { withFields } from '../obs/logger';
import type { InboundTurnDeps } from './inbound-turn';

/**
 * Uma resposta por turno à secretaria: `seq 1`. O ledger deduplica por (job, seq), então o replay de um job que caiu
 * depois de enviar não manda a mesma resposta duas vezes.
 */
export const SEQ_DA_RESPOSTA = 1;
/** A mensagem ao PACIENTE no mesmo job (a reserva fala com os dois): outra posição, para os dois não colidirem. */
export const SEQ_DO_PACIENTE = 2;

export type Registro = ReturnType<typeof withFields>;

/** Fuso padrão quando nem a jornada do dono nem a organização dizem qual é. */
const FUSO_PADRAO = 'America/Sao_Paulo';

/** O fuso da agenda: o da jornada do dono; senão o da organização; senão o padrão. */
export async function fusoDaAgenda(
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

export interface EnvioDoBastidor {
  pool: pg.Pool;
  channel: ChannelAdapter;
  deps: InboundTurnDeps;
  log: Registro;
  tenantId: string;
  leadId: string;
  jobId: string;
  conversationId: string;
  channelSessionId: string;
  corpo: string;
  tipo: TipoDeMensagemDoBastidor;
  agora: Date;
}

/** O que a cadeia decidiu. `vetado` NÃO é erro do job: é decisão de negócio, e retentar não muda o veredito. */
export type DesfechoDoEnvio = { enviado: true } | { enviado: false; porque: string };

/**
 * Envia à SECRETARIA pela cadeia de guardrails, declarando `bastidor`.
 *
 * `enforceSpinning: false`: o gate de repetição existe para barrar rajada de texto quase igual a MUITOS contatos
 * (blast). Aqui é uma pessoa só da equipe, e as respostas são fixas por desenho ("Sem problema! O que está
 * diferente?" duas vezes no mesmo dia é o comportamento certo, não spam). O bastidor também fica FORA do limite
 * diário: a cadeia não aplica o teto de warm-up/diário a ele e `recordSend` não o conta, então a equipe não gasta a
 * cota das vendas (janela horária e espaçamento continuam valendo).
 *
 * Veto da cadeia NÃO é erro do job: registra e segue. Retentar não muda o veredito (janela, opt-out), e o job morto
 * geraria alerta crítico por algo que é decisão de negócio.
 */
export async function enviarAoBastidor(e: EnvioDoBastidor): Promise<DesfechoDoEnvio> {
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
    return { enviado: false, porque: chain.code };
  }
  e.log.info('bastidor: resposta enviada', { resultado: chain.outcome.kind });
  return { enviado: true };
}

export interface EnvioAoPaciente {
  pool: pg.Pool;
  channel: ChannelAdapter;
  deps: InboundTurnDeps;
  log: Registro;
  tenantId: string;
  pacienteId: string;
  jobId: string;
  conversationId: string;
  channelSessionId: string;
  corpo: string;
  agora: Date;
}

/**
 * Envia ao PACIENTE pela cadeia inteira (sem `bastidor`). Lê a linha do contato direto do banco para os gates de
 * opt-out e de LGPD — o mesmo cuidado de `avisarLeadLendoOContato`. NUNCA lança por veto: devolve o desfecho para o
 * chamador transformar em aviso à equipe.
 */
export async function enviarAoPaciente(e: EnvioAoPaciente): Promise<DesfechoDoEnvio> {
  const { rows } = await e.pool.query<{
    is_blocked: boolean;
    is_anonymized: boolean;
    source: string | null;
    consent: Record<string, unknown> | null;
  }>('select is_blocked, is_anonymized, source, consent from contacts where organization_id = $1 and id = $2', [
    e.tenantId,
    e.pacienteId,
  ]);
  const c = rows[0];
  if (c === undefined) return { enviado: false, porque: 'contato_inexistente' };
  const optedOutThisTurn = c.is_blocked === true;
  // isProspecting=false: isto responde a alguém que JÁ está numa conversa.
  const lgpd: LgpdInput = deriveLgpdFromContact({ source: c.source, consent: c.consent, is_anonymized: c.is_anonymized }, false);

  const chain = await runBeforeSend({
    pool: e.pool,
    log: e.log,
    tenantId: e.tenantId,
    leadId: e.pacienteId,
    jobId: e.jobId,
    channelSessionId: e.channelSessionId,
    body: e.corpo,
    optedOutThisTurn,
    // Texto fixo, mesmo vocabulário em vários pacientes no mesmo dia: o gate de repetição existe para blast, não para isto.
    enforceSpinning: false,
    crmDailyLimit: null,
    now: e.agora,
    lgpd,
    ...(e.deps.sleep !== undefined ? { sleep: e.deps.sleep } : {}),
    send: (finalBody) =>
      e.channel.send({
        tenantId: e.tenantId,
        leadId: e.pacienteId,
        jobId: e.jobId,
        seq: SEQ_DO_PACIENTE,
        conversationId: e.conversationId,
        body: finalBody,
      }),
  });

  if (chain.status === 'vetoed') {
    e.log.warn('reserva: mensagem ao paciente vetada pela cadeia', { gate: chain.gate, code: chain.code });
    return { enviado: false, porque: chain.code };
  }
  switch (chain.outcome.kind) {
    case 'sent':
    case 'already_sent':
    case 'queued':
      return { enviado: true };
    case 'blocked':
      return { enviado: false, porque: 'contato_bloqueado' };
    case 'failed':
      return { enviado: false, porque: 'canal_falhou' };
    case 'unavailable':
      return { enviado: false, porque: 'canal_indisponivel' };
  }
}
