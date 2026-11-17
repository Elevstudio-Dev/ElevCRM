/**
 * O QUE A IA ESCREVE NA CONVERSA DA RESERVA DE HORÁRIO — à secretaria e ao paciente. Tudo texto fixo, em código: quem
 * decide o horário é o servidor e quem fala é uma frase conferida, nunca um modelo improvisando. O paciente só recebe
 * horário que o servidor calculou como livre; a secretaria só recebe a pergunta com o que o paciente pediu.
 *
 * Tom: curto e direto. A secretaria está no meio do expediente e o paciente está esperando.
 */
import type { HorarioLivre } from "@/lib/agenda/secretaria/reservas";
import { rotuloLocal } from "@/lib/tempo/agora";

/** O primeiro nome, para a frase não soar de formulário. "maria da silva" → "Maria". */
export function primeiroNome(nomeCompleto: string): string {
  const primeiro = nomeCompleto.trim().split(/\s+/)[0] ?? "";
  if (primeiro === "") return "";
  return primeiro.charAt(0).toLocaleUpperCase("pt-BR") + primeiro.slice(1).toLocaleLowerCase("pt-BR");
}

/** À secretaria: o pedido, com tudo que ela precisa para responder só "sim" ou "não". */
export function perguntaDaReserva(entrada: { nomePaciente: string; inicio: Date; fuso: string; minutos: number }): string {
  const quando = rotuloLocal(entrada.inicio, entrada.fuso);
  return (
    `Pedido de horário: ${entrada.nomePaciente} quer ${quando}. ` +
    `Esse horário está livre na agenda? Responda SIM para confirmar ou NÃO se estiver ocupado. ` +
    `Estou segurando o horário por ${entrada.minutos} minutos.`
  );
}

/** Ela respondeu depois da validade: o paciente já recebeu outros horários, então um "sim" tardio não vale. */
export const TEXTO_RESERVA_JA_VENCEU =
  "Esse pedido de horário já venceu e o paciente foi avisado com outras opções. Se ainda der para atendê-lo, é só a equipe combinar com ele.";

export function textoDaSecretariaAposSim(entrada: { nomePaciente: string; inicio: Date; fuso: string }): string {
  return `Anotado! Horário de ${entrada.nomePaciente} confirmado: ${rotuloLocal(entrada.inicio, entrada.fuso)}. Já avisei o paciente.`;
}

export function textoDaSecretariaAposNao(nomePaciente: string): string {
  return `Certo, avisei ${nomePaciente} que esse horário não dá e ofereci outros.`;
}

export function textoDaSecretariaQuandoNaoDeuParaAnotar(entrada: { nomePaciente: string; inicio: Date; fuso: string }): string {
  return (
    `Não consegui anotar ${rotuloLocal(entrada.inicio, entrada.fuso)}: esse horário acabou de ser ocupado aqui no CRM. ` +
    `Avisei ${entrada.nomePaciente} e ofereci outros.`
  );
}

export function textoDaSecretariaQuandoVenceu(entrada: { nomePaciente: string; inicio: Date; fuso: string }): string {
  return (
    `O pedido de horário de ${entrada.nomePaciente} (${rotuloLocal(entrada.inicio, entrada.fuso)}) venceu sem resposta. ` +
    `Avisei o paciente e ofereci outros horários.`
  );
}

/** Ao paciente: o horário foi confirmado pela recepção. */
export function textoDoPacienteConfirmado(entrada: { nomePaciente: string; inicio: Date; fuso: string }): string {
  const nome = primeiroNome(entrada.nomePaciente);
  const quando = rotuloLocal(entrada.inicio, entrada.fuso);
  return `Tudo certo${nome ? `, ${nome}` : ""}! Seu horário está confirmado para ${quando}. Se surgir algum imprevisto, é só me avisar por aqui.`;
}

/** Ao paciente: o horário não deu — com até dois horários livres calculados pelo servidor. */
export function textoDoPacienteComAlternativas(entrada: {
  nomePaciente: string;
  alternativas: readonly HorarioLivre[];
  fuso: string;
}): string {
  const nome = primeiroNome(entrada.nomePaciente);
  const abertura = `Poxa${nome ? `, ${nome}` : ""}, esse horário acabou de ser preenchido.`;
  const quando = entrada.alternativas.map((a) => rotuloLocal(a.inicio, entrada.fuso));
  if (quando.length === 0) {
    return `${abertura} Não encontrei outro horário livre agora, então vou pedir para a recepção te chamar para combinar um novo horário.`;
  }
  if (quando.length === 1) {
    return `${abertura} Tenho disponível ${quando[0]}. Esse horário serve para você?`;
  }
  return `${abertura} Tenho disponível ${quando[0]} ou ${quando[1]}. Qual deles fica melhor para você?`;
}
