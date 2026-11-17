/**
 * AS PERGUNTAS DIÁRIAS À SECRETARIA — a decisão de QUANDO perguntar, lembrar e avisar o administrador.
 *
 * A agenda daqui é um espelho do que a secretaria conta (ver `atualidade.ts`). Espelho velho faz a IA parar de
 * oferecer horário, então a IA PERGUNTA em horários fixos (padrão 08:30, 14:00 e 18:15, de segunda a sexta, no fuso
 * da agenda). Se ela não responde, a IA lembra UMA vez; se continua sem responder, avisa o administrador. Nunca
 * insiste mais que isso: a secretaria está atendendo gente.
 *
 * Esta função é PURA: recebe o relógio e o que já foi perguntado hoje e devolve as ações. O cron
 * (`app/api/v1/cron/secretaria-agenda`) executa e `perguntas-supabase.ts` liga ao banco.
 *
 * ## Por que não "perguntou? marca e pergunta" num passo só
 *
 * A chave única do banco (organização + contato + dia + horário) é a idempotência: o cron roda a cada 5 minutos, e
 * a mesma pergunta nunca sai duas vezes mesmo se duas instâncias rodarem juntas. A decisão aqui só diz o que FALTA
 * fazer; quem grava a linha primeiro, ganha.
 */
import { diaDaSemanaLocal, diaLocalISO, instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import type { ConfigDaSecretaria } from "@/lib/agenda/secretaria/config";

const MINUTO = 60_000;

/** Passou disto do horário marcado, a pergunta já não faz sentido (o cron ficou fora do ar): não pergunta. */
export const TOLERANCIA_DA_PERGUNTA_MIN = 120;
/** Quanto esperar a resposta antes de lembrar (uma vez). */
export const ESPERA_ANTES_DO_LEMBRETE_MIN = 30;
/** Quanto esperar, depois do lembrete, antes de avisar o administrador. */
export const ESPERA_ANTES_DO_AVISO_MIN = 30;
/** Agenda conferida há menos que isto antes do horário: a pergunta seria repetição, e é dispensada. */
export const DISPENSA_SE_CONFERIDA_HA_MIN = 60;

/** O que já aconteceu com uma pergunta de hoje. */
export interface PerguntaFeita {
  dia: string;
  horario: string;
  /** `pedida` ainda espera resposta; as outras duas já estão resolvidas (nada a fazer). */
  estado: "pedida" | "dispensada" | "sem_conversa";
  pedidaEm: Date;
  lembretePedidoEm: Date | null;
  respondidaEm: Date | null;
  adminAvisadoEm: Date | null;
}

export type AcaoDaPergunta =
  | { tipo: "perguntar"; dia: string; horario: string }
  | { tipo: "dispensar"; dia: string; horario: string }
  | { tipo: "lembrar"; dia: string; horario: string }
  | { tipo: "avisar_admin"; dia: string; horario: string };

export interface EntradaDoPlano {
  config: ConfigDaSecretaria;
  fuso: string;
  /** INJETADO. */
  agora: Date;
  /** As perguntas DE HOJE (outros dias não interessam). */
  feitas: readonly PerguntaFeita[];
  /** A última conferência da agenda (qualquer dia), ou nulo se nunca houve. */
  ultimaConferidaEm: Date | null;
}

/** "HH:MM" → { hora, minuto }. A config já validou o formato. */
function hm(horario: string): { hora: number; minuto: number } {
  const [h = "0", m = "0"] = horario.split(":");
  return { hora: Number(h), minuto: Number(m) };
}

export function planejarPerguntas(e: EntradaDoPlano): AcaoDaPergunta[] {
  const { config, fuso, agora } = e;
  if (!config.ativa) return [];
  if (!config.dias.includes(diaDaSemanaLocal(agora, fuso))) return [];

  const hoje = diaLocalISO(agora, fuso);
  const { ano, mes, dia } = partesNoFuso(agora, fuso);
  const acoes: AcaoDaPergunta[] = [];

  // Ordenado e sem repetição: dois horários iguais na config não podem virar duas perguntas.
  const horarios = [...new Set(config.perguntas)].sort();
  for (const horario of horarios) {
    const { hora, minuto } = hm(horario);
    const marcado = instanteDe({ ano, mes, dia, hora, minuto }, fuso);
    const atrasoMin = (agora.getTime() - marcado.getTime()) / MINUTO;
    const feita = e.feitas.find((f) => f.dia === hoje && f.horario === horario);

    if (feita === undefined) {
      if (atrasoMin < 0) continue; // ainda não é a hora
      if (atrasoMin > TOLERANCIA_DA_PERGUNTA_MIN) continue; // perdeu a hora: perguntar agora seria fora de propósito
      const conferidaHaPouco =
        e.ultimaConferidaEm !== null &&
        e.ultimaConferidaEm.getTime() >= marcado.getTime() - DISPENSA_SE_CONFERIDA_HA_MIN * MINUTO &&
        e.ultimaConferidaEm.getTime() <= agora.getTime();
      acoes.push({ tipo: conferidaHaPouco ? "dispensar" : "perguntar", dia: hoje, horario });
      continue;
    }

    // Já resolvida: respondida, dispensada, sem conversa, ou o administrador já foi avisado.
    if (feita.estado !== "pedida" || feita.respondidaEm !== null || feita.adminAvisadoEm !== null) continue;

    if (feita.lembretePedidoEm === null) {
      if (agora.getTime() - feita.pedidaEm.getTime() >= ESPERA_ANTES_DO_LEMBRETE_MIN * MINUTO) {
        acoes.push({ tipo: "lembrar", dia: hoje, horario });
      }
      continue;
    }
    if (agora.getTime() - feita.lembretePedidoEm.getTime() >= ESPERA_ANTES_DO_AVISO_MIN * MINUTO) {
      acoes.push({ tipo: "avisar_admin", dia: hoje, horario });
    }
  }
  return acoes;
}
