import { NOME_DE_TODOS, chaveDaMencao, type CandidatoDeMencao, type Mencao } from "./tipos";

/** O `@` que o cursor está completando, ou `null` se não há nenhum. */
export interface GatilhoDeMencao {
  /** Posição do `@` no texto. */
  inicio: number;
  /** O que foi digitado depois do `@`, até o cursor. */
  consulta: string;
}

/** Quantos caracteres depois do `@` ainda contam como "estou escolhendo um nome". */
const TETO_DA_CONSULTA = 30;

/**
 * O `@` que o cursor está completando.
 *
 * Só vale se o `@` abre uma palavra — no começo do texto ou depois de espaço ou
 * quebra de linha. É o que impede `ana@empresa.com` de abrir a lista no meio de
 * um e-mail. A consulta pode ter espaços (o nome tem sobrenome), mas não quebra
 * de linha, e é cortada em `TETO_DA_CONSULTA`: quem escreveu "@" e depois uma
 * frase inteira não está escolhendo ninguém.
 */
export function gatilhoDeMencao(texto: string, cursor: number): GatilhoDeMencao | null {
  const ate = texto.slice(0, cursor);
  const arroba = ate.lastIndexOf("@");
  if (arroba < 0) return null;
  const antes = arroba === 0 ? "" : (ate[arroba - 1] ?? "");
  if (antes !== "" && !/\s/.test(antes)) return null;
  const consulta = ate.slice(arroba + 1);
  if (consulta.includes("\n") || consulta.length > TETO_DA_CONSULTA) return null;
  return { inicio: arroba, consulta };
}

/** Sem acento e sem caixa: "José" casa com "jose". */
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Quem casa com o que foi digitado: o começo de QUALQUER palavra do nome
 * (digitar "sou" acha "Ana Souza"). A linha do `@todos` entra quando a consulta
 * é o começo de "todos" — ou está vazia, para ser a primeira da lista.
 */
export function filtrarCandidatos(
  candidatos: ReadonlyArray<CandidatoDeMencao>,
  consulta: string,
): CandidatoDeMencao[] {
  const q = normalizar(consulta);
  const casa = (c: CandidatoDeMencao) => {
    if (q === "") return true;
    if (c.todos) return NOME_DE_TODOS.startsWith(q);
    return normalizar(c.nome)
      .split(/\s+/)
      .some((palavra) => palavra.startsWith(q)) || normalizar(c.nome).startsWith(q);
  };
  const achados = candidatos.filter(casa);
  // "todos" sempre no topo; o resto na ordem recebida.
  return [...achados.filter((c) => c.todos), ...achados.filter((c) => !c.todos)];
}

/** O texto com o `@consulta` trocado por `@Nome `, e onde fica o cursor depois. */
export function aplicarMencao(
  texto: string,
  gatilho: GatilhoDeMencao,
  cursor: number,
  nome: string,
): { texto: string; cursor: number } {
  const inserido = `@${nome} `;
  const novo = texto.slice(0, gatilho.inicio) + inserido + texto.slice(cursor);
  return { texto: novo, cursor: gatilho.inicio + inserido.length };
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Letras e números de qualquer língua — o que NÃO pode vir colado depois do nome. */
const LETRA_OU_NUMERO = /[\p{L}\p{N}]/u;

/** Onde cada `@nome` aparece no texto, com o início e o fim. */
function ocorrencias(texto: string, nome: string): Array<{ inicio: number; fim: number }> {
  const achados: Array<{ inicio: number; fim: number }> = [];
  const re = new RegExp(`@${escapar(nome)}`, "giu");
  for (const m of texto.matchAll(re)) {
    const inicio = m.index ?? 0;
    const fim = inicio + m[0].length;
    const antes = inicio === 0 ? "" : (texto[inicio - 1] ?? "");
    const depois = texto[fim] ?? "";
    // `@Ana` dentro de `@Ananda` não é a Ana; nem `x@Ana` é uma marcação.
    if (antes !== "" && !/\s/.test(antes)) continue;
    if (depois !== "" && LETRA_OU_NUMERO.test(depois)) continue;
    achados.push({ inicio, fim });
  }
  return achados;
}

function nomeNoTexto(m: Mencao): string {
  return m.tipo === "todos" ? NOME_DE_TODOS : m.nome;
}

/**
 * As marcações que AINDA estão no texto. Quem escreveu `@Ana`, mudou de ideia e
 * apagou o nome não quer avisar a Ana — e a lista que vai ao servidor é feita
 * daqui, não do que ficou guardado no estado do campo.
 */
export function mencoesQueSobraram(texto: string, mencoes: ReadonlyArray<Mencao>): Mencao[] {
  const vistas = new Set<string>();
  const saida: Mencao[] = [];
  for (const m of mencoes) {
    const chave = chaveDaMencao(m);
    if (vistas.has(chave)) continue;
    if (ocorrencias(texto, nomeNoTexto(m)).length === 0) continue;
    vistas.add(chave);
    saida.push(m);
  }
  return saida;
}

/** Um pedaço do texto: comum, ou o nome de alguém marcado. */
export interface Trecho {
  texto: string;
  mencao?: Mencao;
}

/**
 * O texto cortado em pedaços para a tela: o que é comum e o que é `@Nome`.
 * Nomes mais longos primeiro, para `@Ana Souza` não ser lida como `@Ana`.
 */
export function trechosComMencao(texto: string, mencoes: ReadonlyArray<Mencao>): Trecho[] {
  if (mencoes.length === 0 || texto === "") return [{ texto }];
  const ordenadas = [...mencoes].sort((a, b) => nomeNoTexto(b).length - nomeNoTexto(a).length);
  const marcados: Array<{ inicio: number; fim: number; mencao: Mencao }> = [];
  for (const m of ordenadas) {
    for (const o of ocorrencias(texto, nomeNoTexto(m))) {
      const sobrepoe = marcados.some((x) => o.inicio < x.fim && o.fim > x.inicio);
      if (!sobrepoe) marcados.push({ ...o, mencao: m });
    }
  }
  marcados.sort((a, b) => a.inicio - b.inicio);
  const trechos: Trecho[] = [];
  let pos = 0;
  for (const x of marcados) {
    if (x.inicio > pos) trechos.push({ texto: texto.slice(pos, x.inicio) });
    trechos.push({ texto: texto.slice(x.inicio, x.fim), mencao: x.mencao });
    pos = x.fim;
  }
  if (pos < texto.length) trechos.push({ texto: texto.slice(pos) });
  return trechos;
}
