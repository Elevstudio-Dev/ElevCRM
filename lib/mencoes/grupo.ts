import { z } from "zod";

import { mencoesQueSobraram, trechosComMencao } from "./texto";
import { MAX_MENCOES, NOME_DE_TODOS, type CandidatoDeMencao, type Mencao } from "./tipos";

/**
 * MARCAR UM PARTICIPANTE NUM GRUPO DE WHATSAPP.
 *
 * Aqui a marcação NÃO é de alguém da equipe: é um participante do grupo (em geral o cliente), e quem
 * recebe o aviso é o WhatsApp DELE, no aparelho dele. Por isso o caminho é outro — o texto que sai para
 * o grupo precisa trazer `@<número>` (é o que o WhatsApp desenha como o nome da pessoa, em destaque) e o
 * canal precisa receber a lista de endereços marcados. O que a atendente lê no CRM continua sendo
 * `@Nome`.
 */

/**
 * O endereço de um participante: dígitos + `@c.us` (número) ou `@lid` (o id oculto que o WhatsApp usa em
 * quem esconde o número). `@s.whatsapp.net` é como o mesmo número aparece em alguns payloads.
 */
export const JID_DE_PARTICIPANTE = /^\d{5,20}@(c\.us|lid|s\.whatsapp\.net)$/;

/** Os dígitos de um endereço: `5511999999999@c.us` → `5511999999999`. */
export function digitosDoJid(jid: string): string {
  return jid.split("@")[0] ?? "";
}

/** O endereço no formato que o canal espera (`@s.whatsapp.net` e `@c.us` são o mesmo número). */
export function jidParaEnvio(jid: string): string {
  return jid.endsWith("@s.whatsapp.net") ? `${digitosDoJid(jid)}@c.us` : jid;
}

/**
 * O que o NAVEGADOR manda sobre quem foi marcado num grupo. Diferente da equipe, aqui o nome vem do
 * cliente — é o rótulo que a atendente viu na lista e que está no texto dela. Ele só serve para achar
 * o `@Nome` no texto e trocá-lo por `@<número>`, e para a bolha mostrar o nome depois; quem recebe no
 * WhatsApp nunca o vê.
 */
export const mencaoDeGrupoPedidaSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("participante"),
    jid: z.string().regex(JID_DE_PARTICIPANTE),
    nome: z.string().trim().min(1).max(100).regex(/^[^\n\r]+$/),
  }),
  z.object({ tipo: z.literal("todos") }),
]);
export const mencoesDeGrupoPedidasSchema = z.array(mencaoDeGrupoPedidaSchema).max(MAX_MENCOES).optional();

export interface MencoesDeGrupoPreparadas {
  /** O texto que SAI para o grupo: cada `@Nome` vira `@<número>`. */
  textoDeEnvio: string;
  /** Os endereços marcados, sem repetição e no formato do canal. */
  jids: string[];
  /** `@todos` — o canal marca o grupo inteiro. */
  todos: boolean;
  /** O que fica guardado na mensagem (para a bolha mostrar os nomes). */
  gravar: Mencao[];
}

/**
 * Do texto da atendente ao que sai para o grupo.
 *
 * Só vale a marcação cujo `@Nome` ainda está no texto — a mesma regra da equipe. Marcação de quem não é
 * participante do grupo não é problema deste passo: o WhatsApp ignora um endereço que não está no grupo.
 *
 * O `@todos` fica como está no texto (é o que a atendente escreveu) e liga `todos`: quem marca o grupo
 * inteiro é o canal, não nós — não temos como saber a lista de todos no momento do envio sem uma
 * chamada a mais, e ela mudaria entre a lista e o envio.
 */
export function prepararMencoesDeGrupo(texto: string, pedidas: ReadonlyArray<Mencao>): MencoesDeGrupoPreparadas {
  const validas = pedidas.filter((m) => m.tipo === "participante" || m.tipo === "todos");
  const gravar = mencoesQueSobraram(texto, validas);
  const textoDeEnvio = trechosComMencao(texto, gravar)
    .map((t) => (t.mencao?.tipo === "participante" ? `@${digitosDoJid(t.mencao.jid)}` : t.texto))
    .join("");
  const jids = [
    ...new Set(
      gravar.flatMap((m) => (m.tipo === "participante" ? [jidParaEnvio(m.jid)] : [])),
    ),
  ];
  return { textoDeEnvio, jids, todos: gravar.some((m) => m.tipo === "todos"), gravar };
}

/** Um participante do grupo, como a tela o recebe. */
export interface ParticipanteDoGrupo {
  jid: string;
  /** Como aparece depois do `@`: o nome que se conhece ou, sem ele, o número. */
  nome: string;
  /** O telefone (só dígitos), quando o canal o diz. */
  telefone: string | null;
  admin: boolean;
  /**
   * `nome` é o que a PESSOA usa no WhatsApp (visto nas mensagens dela), e não o número ou o rótulo de
   * quem nunca escreveu. Só um nome conhecido serve para trocar o `@<número>` que chega numa mensagem.
   */
  conhecido: boolean;
}

/**
 * A lista do menu para um GRUPO: `@todos` no topo e cada participante. Sem participante, nada.
 *
 * A linha pequena de cada um mostra o telefone — só quando o NOME é outra coisa; quando o nome já é o
 * número, repeti-lo seria ruído — e se é admin do grupo (`rotuloDeAdmin`, já traduzido por quem chama).
 */
export function candidatosDoGrupo(
  participantes: ReadonlyArray<ParticipanteDoGrupo>,
  rotuloDeAdmin: string,
): CandidatoDeMencao[] {
  if (participantes.length === 0) return [];
  return [
    { id: "todos", nome: NOME_DE_TODOS, todos: true },
    ...participantes.map((p) => {
      const telefone = p.telefone && !p.nome.includes(p.telefone) ? `+${p.telefone}` : null;
      const detalhe = [telefone, p.admin ? rotuloDeAdmin : null].filter(Boolean).join(" · ");
      return { id: p.jid, nome: p.nome, detalhe: detalhe || null };
    }),
  ];
}

/** A linha escolhida vira a marcação do grupo. */
export function mencaoDeGrupo(c: CandidatoDeMencao): Mencao {
  return c.todos ? { tipo: "todos" } : { tipo: "participante", jid: c.id, nome: c.nome };
}
