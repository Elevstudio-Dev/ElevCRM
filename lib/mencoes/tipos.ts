/**
 * MARCAR ALGUÉM COM @ — o vocabulário comum às três telas (chat da equipe, nota
 * interna e grupo de WhatsApp).
 *
 * ## Por que a menção é GUARDADA, e não só lida do texto
 *
 * O texto diz `@Ana Souza`, mas só o id diz QUEM é — duas pessoas podem se chamar
 * Ana, e o nome pode mudar depois. Por isso quem escreve manda, junto com o texto,
 * a lista de quem foi marcado, e o servidor a confere contra quem PODE ser marcado
 * ali (quem enxerga aquele canal ou aquela conversa) antes de gravar e de avisar.
 *
 * O texto continua sendo a fonte do que aparece na tela: a menção só vale se o
 * `@Nome` ainda estiver nele (ver `mencoesQueSobraram`). Apagar o nome do texto
 * desfaz a marcação; não existe marcação "fantasma" que avisa alguém por uma
 * palavra que ninguém mais vê.
 */

/** Uma pessoa da equipe marcada pelo nome. */
export interface MencaoDePessoa {
  tipo: "pessoa";
  user_id: string;
  /** O nome como foi escrito no texto, depois do `@`. */
  nome: string;
}

/**
 * Alguém de FORA da equipe, num grupo de WhatsApp — o cliente que o atendente
 * marca para o aparelho dele tocar. O `jid` é o endereço dele no WhatsApp
 * (`5511999999999@c.us`), não um usuário do CRM.
 */
export interface MencaoDeParticipante {
  tipo: "participante";
  jid: string;
  nome: string;
}

/** Todo mundo que enxerga o canal ou a conversa (o `@todos` do grupo de WhatsApp). */
export interface MencaoDeTodos {
  tipo: "todos";
}

export type Mencao = MencaoDePessoa | MencaoDeParticipante | MencaoDeTodos;

/** A identidade de uma marcação, para não contar a mesma pessoa duas vezes. */
export function chaveDaMencao(m: Mencao): string {
  if (m.tipo === "todos") return "todos";
  return m.tipo === "pessoa" ? `p:${m.user_id}` : `g:${m.jid}`;
}

/** Alguém que pode ser escolhido na lista que abre ao digitar `@`. */
export interface CandidatoDeMencao {
  /** Chave estável da linha (user_id, ou o id do participante do grupo). */
  id: string;
  /** O que aparece depois do `@` no texto. */
  nome: string;
  /** Linha pequena embaixo do nome (cargo, setor, telefone). Opcional. */
  detalhe?: string | null;
  /** `true` na linha do `@todos`. */
  todos?: boolean;
}

/** O texto que vem depois do `@` na linha de "todos". */
export const NOME_DE_TODOS = "todos";

/** Teto de marcações por mensagem — o `@todos` conta como uma. */
export const MAX_MENCOES = 20;
