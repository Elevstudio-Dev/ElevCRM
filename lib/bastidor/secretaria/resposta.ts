/**
 * O QUE A SECRETARIA RESPONDEU AO RESUMO — "sim", "não" ou outra coisa.
 *
 * Só o "sim" mexe na agenda, então esta leitura é CONSERVADORA de propósito e não usa modelo: ou a mensagem é uma
 * confirmação inequívoca e curta, ou não é. Qualquer dúvida cai em `outro`, e `outro` faz a IA reler o que ela
 * escreveu como uma correção e devolver um resumo novo para conferir — o custo de errar para esse lado é uma
 * pergunta a mais; errar para o lado do "sim" seria gravar uma agenda que a secretaria não aprovou.
 *
 * Exemplos que NÃO são "sim": "sim, mas a Ana é às 15h" (tem correção), "ok, e quinta?" (tem pergunta), "14h Maria"
 * (é dado novo), "não sei" (negação com conteúdo).
 */

export type RespostaDaConferencia = "sim" | "nao" | "outro";

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const AGRADECIMENTO = "( (obrigada|obrigado|valeu|vlw|brigada|brigado))?";

/** Confirmação inteira, nada a mais. O ancorar em ^…$ é o que impede "sim, mas…" de passar. */
const SIM = new RegExp(
  "^(" +
    [
      "sim",
      "sim senhor",
      "sim isso",
      "sim isso mesmo",
      "sim esta certo",
      "sim ta certo",
      "sim esta correto",
      "isso",
      "isso mesmo",
      "isso ai",
      "exato",
      "exatamente",
      "certo",
      "certinho",
      "correto",
      "ok",
      "okay",
      "blz",
      "beleza",
      "perfeito",
      "positivo",
      "confirmo",
      "confirmado",
      "tudo certo",
      "tudo ok",
      "tudo bem",
      "esta certo",
      "ta certo",
      "esta correto",
      "ta correto",
      "pode ser",
      "pode sim",
      "pode",
    ].join("|") +
    ")" +
    AGRADECIMENTO +
    "$",
);

/** Negação seca, sem informação nova. "não, a Ana é 15h" tem informação e vira `outro` (correção). */
const NAO = new RegExp(
  "^(nao|errado|errada|incorreto|negativo|nao esta certo|nao ta certo|nao esta correto|nao ta correto|esta errado|ta errado|nao e isso|nao foi isso)$",
);

/** Só emoji de positivo, sem palavra nenhuma. */
const SO_POSITIVO =
  /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]*(👍|✅|👌|🙏)[\s\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]*$/u;

export function interpretarRespostaDeConferencia(texto: string): RespostaDaConferencia {
  const bruto = texto.trim();
  if (bruto === "") return "outro";
  if (SO_POSITIVO.test(bruto)) return "sim";
  const n = normalizar(bruto);
  if (n === "") return "outro";
  if (SIM.test(n)) return "sim";
  if (NAO.test(n)) return "nao";
  return "outro";
}
