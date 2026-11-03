import { digitosDoJid } from "./grupo";
import type { Mencao } from "./tipos";

/**
 * A MARCAÇÃO QUE CHEGA — o `@<número>` que alguém escreveu num grupo, mostrado como o NOME.
 *
 * Quando um participante marca outro (ou quando a equipe marca pelo celular), o WhatsApp entrega o corpo
 * da mensagem com `@117137179947104` — o identificador, não o nome: quem lê o CRM via um número cru no
 * meio da frase. O aparelho resolve o número pelo nome que ele conhece; o CRM, pelo que sabe do grupo
 * (a lista de participantes que o `@` já usa).
 *
 * Só troca o que SABE: número sem nome conhecido fica como chegou — um `@Participante 947104` no lugar
 * de um número que a atendente talvez reconheça seria piorar.
 */

export interface MencoesDeEntrada {
  texto: string;
  mencoes: Mencao[];
}

/** O que importa de um participante para dar nome a um número. */
interface ParticipanteComNome {
  jid: string;
  nome: string;
  telefone: string | null;
  /** O nome é o que a pessoa usa (e não o número ou o rótulo de quem nunca escreveu). */
  conhecido: boolean;
}

/** `dígitos → nome`, pelo endereço e pelo telefone, só de quem tem nome de verdade. */
export function nomesPorNumero(participantes: ReadonlyArray<ParticipanteComNome>): Map<string, string> {
  const nomes = new Map<string, string>();
  for (const p of participantes) {
    if (!p.conhecido) continue;
    nomes.set(digitosDoJid(p.jid), p.nome);
    if (p.telefone) nomes.set(p.telefone, p.nome);
  }
  return nomes;
}

/** `@` seguido de 5 a 20 dígitos, no começo de uma palavra e sem letra ou número colados depois. */
const NUMERO_MARCADO = /(^|\s)@(\d{5,20})(?![\p{L}\p{N}])/gu;

export function nomearMencoesDeEntrada(body: string, nomes: ReadonlyMap<string, string>): MencoesDeEntrada {
  if (nomes.size === 0) return { texto: body, mencoes: [] };
  const mencoes: Mencao[] = [];
  const vistos = new Set<string>();
  const texto = body.replace(NUMERO_MARCADO, (inteiro: string, antes: string, digitos: string) => {
    const nome = nomes.get(digitos);
    if (!nome) return inteiro;
    if (!vistos.has(digitos)) {
      vistos.add(digitos);
      mencoes.push({ tipo: "participante", jid: `${digitos}@c.us`, nome });
    }
    return `${antes}@${nome}`;
  });
  return { texto, mencoes };
}
