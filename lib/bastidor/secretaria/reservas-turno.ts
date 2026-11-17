/**
 * A CONVERSA DA RESERVA — o que fazer com a resposta da secretaria ("sim"/"não") e com o vencimento.
 *
 * Como `turno.ts`, este arquivo é só a ORQUESTRAÇÃO: sem banco, sem canal, sem modelo. Tudo que toca o mundo entra por
 * `PortasDaReserva`, e o roteiro inteiro é testado com portas de mentira. O handler do worker liga as portas.
 *
 *   resposta dela   reserva ainda vale?   o que acontece
 *   ─────────────   ───────────────────   ───────────────────────────────────────────────────────────────
 *   "sim"           sim                   o servidor MARCA o compromisso; paciente e secretaria são avisados
 *   "sim"           sim, mas o horário    o paciente recebe horários parecidos; a secretaria é avisada
 *                   foi ocupado no CRM
 *   "não"           sim                   o paciente recebe horários parecidos
 *   qualquer        não (venceu)          a secretaria ouve que venceu; nada muda (o paciente já foi avisado)
 *   (ninguém)       venceu                vencimento (o cron fecha a reserva): o paciente recebe horários parecidos;
 *                                         a equipe e a secretaria são avisadas
 *
 * Duas regras que não se negociam:
 *  1. O compromisso só nasce no "sim" inequívoco, de reserva ainda dentro da validade, e só UMA vez: quem fecha a
 *     reserva a "reivindica" (`fechar` devolve `false` para quem chega depois).
 *  2. Quem fala com o paciente é uma frase fixa (`reservas-textos.ts`) com horários que o SERVIDOR calculou como
 *     livres — a IA não inventa alternativa.
 */
import type { HorarioLivre, Reserva } from "@/lib/agenda/secretaria/reservas";
import { reservaValeAinda } from "@/lib/agenda/secretaria/reservas";

import {
  TEXTO_RESERVA_JA_VENCEU,
  textoDaSecretariaAposNao,
  textoDaSecretariaAposSim,
  textoDaSecretariaQuandoNaoDeuParaAnotar,
  textoDaSecretariaQuandoVenceu,
  textoDoPacienteComAlternativas,
  textoDoPacienteConfirmado,
} from "./reservas-textos";

export type ResultadoDaMarcacao = { ok: true; appointmentId: string } | { ok: false };

export interface PortasDaReserva {
  agora: Date;
  /** Fuso da agenda, para escrever o dia e a hora. */
  fuso: string;
  reserva: Reserva;

  /** Reivindica o fechamento. `false` = alguém já fechou (a resposta dela e o vencimento no mesmo minuto). */
  fechar(status: "confirmada" | "recusada"): Promise<boolean>;
  /** Marca o compromisso de verdade, ignorando a própria reserva (ela seguraria o horário). Recusa de negócio = `ok: false`. */
  marcar(reserva: Reserva): Promise<ResultadoDaMarcacao>;
  ligarAoCompromisso(appointmentId: string): Promise<void>;
  /** A confirmação não vingou: a reserva volta a ser `recusada`. */
  reverter(): Promise<void>;
  /** Horários livres parecidos com o pedido (até 2), já sem o horário recusado. */
  horariosParecidos(reserva: Reserva): Promise<HorarioLivre[]>;

  /** Manda ao PACIENTE. A porta cuida do replay (carimbo) e de vetos da cadeia (cai no aviso da equipe). */
  avisarPaciente(texto: string): Promise<void>;
  avisarSecretaria(texto: string): Promise<void>;
  /** Chama a equipe pela Central de avisos (ex.: não há horário parecido; a secretaria não respondeu). */
  avisarEquipe(aviso: { titulo: string; corpo: string }): Promise<void>;
}

export type DesfechoDaReserva =
  | { acao: "confirmada"; appointmentId: string }
  | { acao: "recusada"; alternativas: number }
  | { acao: "conflito_ao_marcar"; alternativas: number }
  | { acao: "vencida_antes_da_resposta" }
  | { acao: "ja_fechada" }
  | { acao: "vencimento"; alternativas: number };

/** Oferece horários parecidos ao paciente; se não houver nenhum, a equipe é chamada para combinar à mão. */
async function oferecerOutrosHorarios(p: PortasDaReserva): Promise<number> {
  const alternativas = await p.horariosParecidos(p.reserva);
  await p.avisarPaciente(
    textoDoPacienteComAlternativas({ nomePaciente: p.reserva.nomePaciente, alternativas, fuso: p.fuso }),
  );
  if (alternativas.length === 0) {
    await p.avisarEquipe({
      titulo: `${p.reserva.nomePaciente} ficou sem horário parecido para oferecer`,
      corpo:
        `O horário que ${p.reserva.nomePaciente} escolheu não deu certo e a IA não achou outro livre agora. ` +
        `Ele foi avisado de que a recepção vai chamar. Abra a conversa e combine um horário.`,
    });
  }
  return alternativas.length;
}

/** A secretaria respondeu "sim" ou "não" ao pedido de horário. */
export async function responderAoPedidoDeReserva(
  p: PortasDaReserva,
  resposta: "sim" | "nao",
): Promise<DesfechoDaReserva> {
  if (!reservaValeAinda(p.reserva, p.agora)) {
    await p.avisarSecretaria(TEXTO_RESERVA_JA_VENCEU);
    return { acao: "vencida_antes_da_resposta" };
  }
  const dados = { nomePaciente: p.reserva.nomePaciente, inicio: p.reserva.inicio, fuso: p.fuso };

  if (resposta === "nao") {
    if (!(await p.fechar("recusada"))) return { acao: "ja_fechada" };
    const alternativas = await oferecerOutrosHorarios(p);
    await p.avisarSecretaria(textoDaSecretariaAposNao(p.reserva.nomePaciente));
    return { acao: "recusada", alternativas };
  }

  // "sim": reivindica ANTES de marcar — duas respostas ao mesmo tempo não criam dois compromissos.
  if (!(await p.fechar("confirmada"))) return { acao: "ja_fechada" };
  const marcacao = await p.marcar(p.reserva);
  if (marcacao.ok) {
    await p.ligarAoCompromisso(marcacao.appointmentId);
    await p.avisarPaciente(textoDoPacienteConfirmado(dados));
    await p.avisarSecretaria(textoDaSecretariaAposSim(dados));
    return { acao: "confirmada", appointmentId: marcacao.appointmentId };
  }

  // O horário foi tomado no CRM entre a pergunta e o "sim" (alguém marcou à mão): a confirmação não vale.
  await p.reverter();
  const alternativas = await oferecerOutrosHorarios(p);
  await p.avisarSecretaria(textoDaSecretariaQuandoNaoDeuParaAnotar(dados));
  return { acao: "conflito_ao_marcar", alternativas };
}

/**
 * A validade passou sem resposta. QUEM FECHOU a reserva como `expirada` foi o cron (é ele quem a reivindica e enfileira
 * este aviso), então aqui só se fala: o paciente recebe horários parecidos, a equipe é chamada e a secretaria é
 * informada.
 */
export async function vencerReserva(p: PortasDaReserva): Promise<DesfechoDaReserva> {
  const alternativas = await oferecerOutrosHorarios(p);
  await p.avisarEquipe({
    titulo: `A secretaria não respondeu ao pedido de horário de ${p.reserva.nomePaciente}`,
    corpo:
      `${p.reserva.nomePaciente} escolheu um horário e a secretaria não respondeu a tempo. ` +
      `O paciente foi avisado e recebeu outros horários. Confira a conversa e, se precisar, ajude a fechar.`,
  });
  await p.avisarSecretaria(
    textoDaSecretariaQuandoVenceu({ nomePaciente: p.reserva.nomePaciente, inicio: p.reserva.inicio, fuso: p.fuso }),
  );
  return { acao: "vencimento", alternativas };
}
