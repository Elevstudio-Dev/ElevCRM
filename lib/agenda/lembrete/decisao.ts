/**
 * QUANDO O LEMBRETE DE CONSULTA SAI — e, o que importa mais, quando NÃO sai.
 *
 * Função pura: recebe o que o cron já leu e devolve uma de três respostas. Quem lê
 * o banco e quem fala com o canal estão em `./executar`; aqui só mora a regra,
 * porque regra que depende de relógio e de fuso se prova com datas na mão, não com
 * um banco no ar.
 *
 * ─── As três respostas ────────────────────────────────────────────────────────
 *
 *   enviar  — todas as condições valem agora.
 *   esperar — vale mais tarde (ainda não é a hora, ou a janela de cortesia está
 *             fechada). O compromisso continua `pending` e o próximo tick decide de novo.
 *   pular   — nunca mais vai valer para este horário. Vira `skipped`, terminal; só
 *             remarcar o rearma (trigger da 0217).
 *
 * ─── Por que "armado depois do momento devido" é terminal ────────────────────
 *
 * Marcar para daqui a 3 h com lembrete de 24 h dá um momento devido 21 h ATRÁS. Sem
 * esta regra o tick seguinte mandaria um "lembrete" segundos depois de a pessoa
 * ter combinado o horário — ruído que treina o paciente a ignorar o aviso que
 * importa. O mesmo vale para remarcar para daqui a pouco.
 */
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { janelaDeEnvioAberta } from "@/lib/agent-engine/pacing/engine";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

const MINUTO = 60_000;
const HORA = 60 * MINUTO;

/** Menos que isto antes da consulta, um lembrete já não serve para nada. */
export const ANTECEDENCIA_MINIMA_MS = 60 * MINUTO;

/**
 * Quanto depois do momento devido ainda vale mandar.
 *
 * Existe porque o cron pode ficar fora do ar, ou o canal, ou a janela de cortesia
 * pode ter fechado a noite inteira. Seis horas cobre a noite sem permitir que
 * ligar o lembrete numa terça dispare aviso para quem tem consulta na quarta.
 */
export const ATRASO_MAXIMO_MS = 6 * HORA;

/** Três falhas e o lembrete vira `failed` — com alerta, não em silêncio. */
export const TENTATIVAS_MAXIMAS = 3;

export type MotivoDeEspera = "not_due" | "outside_courtesy_hours";
export type MotivoDeDescarte = "late" | "booked_inside_horizon" | "blocked";

export type DecisaoDoLembrete =
  | { acao: "enviar" }
  | { acao: "esperar"; motivo: MotivoDeEspera }
  | { acao: "pular"; motivo: MotivoDeDescarte };

export interface EntradaDaDecisao {
  agora: Date;
  /** `calendar_appointments.starts_at` */
  comecaEm: Date;
  /** `calendar_event_types.reminder_minutes_before` */
  minutosAntes: number;
  /** `calendar_appointments.reminder_armed_at` */
  armadoEm: Date;
  /** `contacts.is_blocked` ou `is_anonymized` — opt-out é vontade da pessoa. */
  contatoSemMensagens: boolean;
  /** O fuso em que o compromisso foi marcado. */
  fuso: string;
}

/** O instante em que o aviso passou a ser devido. */
export function momentoDevido(comecaEm: Date, minutosAntes: number): Date {
  return new Date(comecaEm.getTime() - minutosAntes * MINUTO);
}

export function decidirLembrete(e: EntradaDaDecisao): DecisaoDoLembrete {
  // Primeiro, o que a pessoa pediu: quem não quer mensagem não recebe, e isto vale
  // antes de qualquer outra conta.
  if (e.contatoSemMensagens) return { acao: "pular", motivo: "blocked" };

  const devido = momentoDevido(e.comecaEm, e.minutosAntes);

  // Armado no momento devido ou depois: a pessoa acabou de combinar o horário.
  // Antes de "tarde demais" de propósito — o motivo verdadeiro é este, e quem lê o
  // histórico quer saber que ninguém falhou.
  if (e.armadoEm.getTime() >= devido.getTime()) {
    return { acao: "pular", motivo: "booked_inside_horizon" };
  }

  // Faltando pouco, ou já passou: lembrete tardio atrapalha mais do que ajuda. A
  // folga mínima nunca passa de metade do que o tipo pediu — um lembrete "30 min
  // antes" que exigisse 60 min de folga não sairia jamais.
  const folgaMinima = Math.min(ANTECEDENCIA_MINIMA_MS, (e.minutosAntes * MINUTO) / 2);
  if (e.comecaEm.getTime() - e.agora.getTime() < folgaMinima) {
    return { acao: "pular", motivo: "late" };
  }

  if (e.agora.getTime() < devido.getTime()) return { acao: "esperar", motivo: "not_due" };

  if (e.agora.getTime() - devido.getTime() > ATRASO_MAXIMO_MS) {
    return { acao: "pular", motivo: "late" };
  }

  // Cortesia, não anti-ban (doutrina de restrição de canal, invariante 3): vale em
  // TODO canal, e é por isso que usa a janela do pacing mesmo onde não há risco de
  // banimento. Ninguém quer ser acordado às 3h por um lembrete de consulta.
  const fuso = fusoValido(e.fuso) ? e.fuso : FUSO_PADRAO;
  if (!janelaDeEnvioAberta(e.agora, { ...PACING_DEFAULTS, timezone: fuso })) {
    return { acao: "esperar", motivo: "outside_courtesy_hours" };
  }

  return { acao: "enviar" };
}
