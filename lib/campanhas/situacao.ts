/**
 * Em que pé está cada destinatário — a regra que a tela mostra, sem banco.
 *
 * A inscrição no motor de follow-up diz só "ativa / concluída / cancelada"; a
 * equipe quer saber "já recebeu? respondeu? pediu para parar?". A tradução é
 * esta, e a ordem dos testes importa: quem pediu para sair aparece como tal
 * mesmo que a inscrição tenha concluído normalmente antes do PARAR.
 */

export type Situacao =
  | "agendado"
  | "enviando"
  | "enviado"
  | "respondeu"
  | "pediu_para_sair"
  | "conversou_antes"
  | "pausado"
  | "cancelado"
  | "falhou";

export const MOTIVO_PAUSA = "campanha_pausada";
export const MOTIVO_CANCELAMENTO = "campanha_cancelada";
/** Nota do nó final do grafo da campanha (vira `cancel_reason` com outcome nulo). */
export const NOTA_ENVIADA = "campanha_enviada";
/** Id do nó de gatilho no grafo da campanha — inscrição parada nele ainda não mandou nada. */
export const NO_GATILHO = "gatilho";

export interface InscricaoResumo {
  status: string;
  current_node_id: string;
  cancel_reason: string | null;
}

export function situacaoDoDestinatario(
  inscricao: InscricaoResumo,
  enviadoEm: string | null,
  respondeuEm: string | null,
  bloqueado: boolean,
): Situacao {
  if (enviadoEm !== null) {
    if (bloqueado) return "pediu_para_sair";
    if (respondeuEm !== null && respondeuEm >= enviadoEm) return "respondeu";
    return "enviado";
  }
  switch (inscricao.status) {
    case "active":
    case "waiting_reply":
      return inscricao.current_node_id === NO_GATILHO ? "agendado" : "enviando";
    case "dead":
      return "falhou";
    case "cancelled":
    case "completed":
      if (inscricao.cancel_reason === MOTIVO_PAUSA) return "pausado";
      if (inscricao.cancel_reason === MOTIVO_CANCELAMENTO) return "cancelado";
      // `cancel_on_reply`: a pessoa escreveu para a clínica antes da vez dela — a
      // conversa seguiu com a equipe/IA e a campanha não se meteu.
      if (inscricao.cancel_reason === "cancel_on_reply") return "conversou_antes";
      return "cancelado";
    default:
      // paused_handoff / paused_manual: alguém da equipe assumiu a conversa.
      return "pausado";
  }
}

export type Contagem = Record<Situacao, number>;

export function contagemVazia(): Contagem {
  return {
    agendado: 0,
    enviando: 0,
    enviado: 0,
    respondeu: 0,
    pediu_para_sair: 0,
    conversou_antes: 0,
    pausado: 0,
    cancelado: 0,
    falhou: 0,
  };
}
