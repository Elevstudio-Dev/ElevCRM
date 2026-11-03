import { NOME_DE_TODOS, type CandidatoDeMencao, type Mencao } from "./tipos";

/** O que a API de "quem pode ser marcado" devolve para a equipe. */
export interface MarcavelDaEquipe {
  user_id: string;
  nome: string;
  role: string;
}

/**
 * A lista do menu para a EQUIPE (chat e nota interna): a linha do `@todos` no
 * topo e depois cada colega. Sem colega nenhum, lista vazia — e lista vazia
 * DESLIGA o `@` no campo. "Avisar todos" quando o único que existe é você não é
 * recurso, é confusão.
 */
export function candidatosDaEquipe(
  lista: ReadonlyArray<MarcavelDaEquipe>,
  rotuloDoPapel: (role: string) => string,
): CandidatoDeMencao[] {
  if (lista.length === 0) return [];
  return [
    { id: "todos", nome: NOME_DE_TODOS, todos: true },
    ...lista.map((m) => ({ id: m.user_id, nome: m.nome, detalhe: rotuloDoPapel(m.role) })),
  ];
}

/** A linha escolhida vira a marcação que vai guardada. */
export function mencaoDaEquipe(c: CandidatoDeMencao): Mencao {
  return c.todos ? { tipo: "todos" } : { tipo: "pessoa", user_id: c.id, nome: c.nome };
}
