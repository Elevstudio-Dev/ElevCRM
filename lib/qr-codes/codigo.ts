/**
 * O CÓDIGO DO QR — o que liga a mensagem que chega ao QR que foi lido.
 *
 * Seis caracteres de um alfabeto SEM ambíguos (sem 0/O, 1/I/L): a pessoa às vezes redigita o código, e o
 * gestor às vezes o lê em voz alta. 31⁶ ≈ 887 milhões de combinações — colisão é tratada no INSERT (unique),
 * não aqui.
 *
 * Tudo puro: o sorteio recebe a fonte de bytes por argumento, e o teste não depende de sorte.
 */
export const ALFABETO_DO_CODIGO = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const TAMANHO_DO_CODIGO = 6;

const RE_CODIGO = /^[2-9A-HJKMNP-Z]{6}$/;
/** `#` + 6 do alfabeto, sem letra/dígito colado antes nem depois. Case-insensitive: o cliente pode redigitar. */
const RE_NA_MENSAGEM = /(?:^|[^\p{L}\p{N}_])#([2-9a-hjkmnp-z]{6})(?![\p{L}\p{N}_])/iu;

/** Maior múltiplo de 31 que cabe num byte: bytes acima dele enviesariam o resto da divisão. */
const LIMITE_SEM_VIES = Math.floor(256 / ALFABETO_DO_CODIGO.length) * ALFABETO_DO_CODIGO.length;

export function gerarCodigo(
  aleatorio: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  let out = "";
  while (out.length < TAMANHO_DO_CODIGO) {
    for (const byte of aleatorio(16)) {
      if (byte >= LIMITE_SEM_VIES) continue;
      out += ALFABETO_DO_CODIGO[byte % ALFABETO_DO_CODIGO.length];
      if (out.length === TAMANHO_DO_CODIGO) break;
    }
  }
  return out;
}

export function normalizarCodigo(bruto: string | null | undefined): string | null {
  const c = (bruto ?? "").trim().toUpperCase();
  return RE_CODIGO.test(c) ? c : null;
}

export function extrairCodigoDaMensagem(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const m = RE_NA_MENSAGEM.exec(texto);
  return m ? normalizarCodigo(m[1]) : null;
}

/** A mensagem que o cliente envia: a frase do gestor + ` #CÓDIGO`. */
export function mensagemComCodigo(mensagem: string, codigo: string): string {
  return `${mensagem.trim()} #${codigo}`;
}
