import type { Mencao } from "./tipos";

/** O que a API da EQUIPE (nota e chat) recebe sobre cada marcação: só o tipo e o id. */
export type MencaoDaEquipeParaApi = { tipo: "pessoa"; user_id: string } | { tipo: "todos" };

/**
 * Tira da marcação o que o servidor não aceita do cliente (o nome) e o que não é
 * da equipe (o participante de grupo de WhatsApp, que tem o próprio caminho).
 */
export function mencoesDaEquipeParaApi(mencoes: ReadonlyArray<Mencao>): MencaoDaEquipeParaApi[] {
  return mencoes.flatMap((m): MencaoDaEquipeParaApi[] => {
    if (m.tipo === "pessoa") return [{ tipo: "pessoa", user_id: m.user_id }];
    if (m.tipo === "todos") return [{ tipo: "todos" }];
    return [];
  });
}
