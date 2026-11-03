import { z } from "zod";

import { mencaoAtingeUsuario, tokensDeMencao } from "@/lib/notifications/mentions";

import { mencoesQueSobraram } from "./texto";
import { MAX_MENCOES, type Mencao } from "./tipos";

/**
 * O que o NAVEGADOR manda sobre quem foi marcado. Só o id (e o tipo): o nome que
 * aparece no texto vem do servidor, nunca do cliente — quem manda `nome: "Diretor"`
 * não consegue pôr outro rótulo no destaque de um id que não é o dele.
 *
 * O Zod descarta campos desconhecidos, então um `nome` mandado a mais some aqui.
 */
export const mencaoPedidaSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("pessoa"), user_id: z.string().uuid() }),
  z.object({ tipo: z.literal("todos") }),
]);
export const mencoesPedidasSchema = z.array(mencaoPedidaSchema).max(MAX_MENCOES).optional().default([]);
export type MencaoPedida = z.infer<typeof mencaoPedidaSchema>;

/** Alguém que pode ser marcado ali — uma linha de `fn_membros_que_veem_conversa` / `fn_membros_do_canal`. */
export interface Marcavel {
  user_id: string;
  role: string;
  full_name: string | null;
  email: string | null;
}

/** O nome que vai para o texto. O banco já cai para o começo do e-mail; "Membro" é só o último recurso. */
export function nomeDoMarcavel(m: Pick<Marcavel, "full_name">): string {
  return m.full_name?.trim() || "Membro";
}

export interface MencoesResolvidas {
  /** O que fica gravado na linha — só o que o texto ainda cita e o servidor confirmou. */
  gravar: Mencao[];
  /** Quem recebe o aviso. Nunca inclui o autor. */
  avisar: string[];
  /** Quantas marcações pedidas foram recusadas por a pessoa não poder ser marcada ali. */
  recusadas: number;
}

/**
 * Confere as marcações pedidas contra quem PODE ser marcado ali e decide quem é
 * avisado.
 *
 * Duas regras de segurança moram aqui, e as duas são "não confie no cliente":
 *
 *  1. Quem não está na lista de `marcaveis` (não enxerga a conversa, não está no
 *     canal, é de outra organização) é recusado em silêncio — mandar o aviso
 *     seria entregar a essa pessoa o começo de uma conversa que ela não abre.
 *  2. O `@todos` avisa os `marcaveis`, nunca "todos da organização".
 *
 * E uma de coerência: a marcação só vale se o `@Nome` ainda está no texto
 * (`mencoesQueSobraram`). Quem apagou o nome não quer avisar ninguém.
 */
export function resolverMencoes(input: {
  texto: string;
  pedidas: ReadonlyArray<MencaoPedida>;
  marcaveis: ReadonlyArray<Marcavel>;
  autorId: string;
}): MencoesResolvidas {
  const porId = new Map(input.marcaveis.map((m) => [m.user_id, m]));
  const candidatas: Mencao[] = [];
  let recusadas = 0;
  for (const p of input.pedidas) {
    if (p.tipo === "todos") {
      candidatas.push({ tipo: "todos" });
      continue;
    }
    const m = porId.get(p.user_id);
    if (!m) {
      recusadas += 1;
      continue;
    }
    candidatas.push({ tipo: "pessoa", user_id: m.user_id, nome: nomeDoMarcavel(m) });
  }

  const gravar = mencoesQueSobraram(input.texto, candidatas);
  const avisar = new Set<string>();
  for (const g of gravar) {
    if (g.tipo === "todos") for (const m of input.marcaveis) avisar.add(m.user_id);
    else if (g.tipo === "pessoa") avisar.add(g.user_id);
  }
  avisar.delete(input.autorId);
  return { gravar, avisar: [...avisar], recusadas };
}

/**
 * O comportamento que a nota SEMPRE teve: quem foi citado só pelo texto digitado
 * (`@ana`) é avisado. Fica para quem escreve sem a lista (outra aplicação, atalho
 * do celular) — mas só entre os `marcaveis`, e só quando a mensagem NÃO traz
 * marcação guardada: havendo, ela manda, porque o texto `@Ana` casaria com duas
 * Anas e a marcação guardada sabe qual das duas foi escolhida.
 */
export function avisadosPeloTexto(input: {
  texto: string;
  marcaveis: ReadonlyArray<Marcavel>;
  autorId: string;
}): string[] {
  if (tokensDeMencao(input.texto).length === 0) return [];
  return input.marcaveis
    .filter((m) => m.user_id !== input.autorId)
    .filter((m) =>
      mencaoAtingeUsuario(input.texto, {
        id: m.user_id,
        email: m.email ?? "",
        full_name: m.full_name,
      }),
    )
    .map((m) => m.user_id);
}
