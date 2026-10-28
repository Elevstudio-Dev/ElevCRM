/**
 * DESLIZAR A MENSAGEM PARA RESPONDER — a decisão do gesto, sem tela.
 *
 * No WhatsApp do celular, responder é arrastar a mensagem para o lado. Aqui o
 * botão existia, mas num celular ele é pequeno e fica ao lado da bolha; quem
 * atende do telefone (que é onde este CRM mais atende) esperava o gesto.
 *
 * O que separa o gesto de um acidente é a DIREÇÃO, e é a parte que precisa de
 * regra: a conversa rola na vertical com o dedo no mesmo lugar onde o gesto
 * começa. Um dedo que desce 30px e anda 10px para o lado é uma rolagem, não uma
 * resposta — e confundir as duas faz a lista pular de resposta em resposta a cada
 * rolada. Por isso o gesto só vale quando o movimento é claramente HORIZONTAL.
 */

/** Quanto a bolha precisa andar para a soltura valer como "responder". */
export const LIMIAR_PARA_RESPONDER = 56;
/** Até onde a bolha acompanha o dedo — depois disso ela para, e o limiar já foi passado. */
export const DESLOCAMENTO_MAXIMO = 72;
/** Quanto tempo o dedo parado vale como "toque longo" (o do WhatsApp: ~½ s). */
export const TEMPO_DO_TOQUE_LONGO_MS = 500;
/** Movimento abaixo disto ainda não diz nada (o dedo treme). */
const FOLGA_DO_DEDO = 8;
/** Quão mais horizontal que vertical o movimento precisa ser. */
const RAZAO_HORIZONTAL = 1.5;

export type LeituraDoGesto =
  /** Ainda não dá para dizer o que é. */
  | { estado: "indeciso" }
  /** É rolagem (vertical): este gesto não é nosso, solta. */
  | { estado: "rolagem" }
  /** É o deslize: a bolha acompanha, `deslocamento` em px. */
  | { estado: "deslizando"; deslocamento: number };

/**
 * `dx`/`dy`: quanto o ponteiro andou desde que encostou. Só o deslize PARA A DIREITA conta
 * (é o do WhatsApp, e deixa o outro sentido livre para um gesto futuro).
 */
export function lerGesto(dx: number, dy: number): LeituraDoGesto {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  if (ady > FOLGA_DO_DEDO && ady > adx) return { estado: "rolagem" };
  if (dx < 0 && adx > FOLGA_DO_DEDO) return { estado: "rolagem" };
  if (dx > FOLGA_DO_DEDO && dx > ady * RAZAO_HORIZONTAL) {
    return { estado: "deslizando", deslocamento: Math.min(dx, DESLOCAMENTO_MAXIMO) };
  }
  return { estado: "indeciso" };
}

/** Soltou: vale como "responder"? */
export function soltouParaResponder(deslocamento: number): boolean {
  return deslocamento >= LIMIAR_PARA_RESPONDER;
}

/**
 * O gesto não pode começar num controle: o player de áudio tem uma barra que se
 * arrasta para o lado (buscar no áudio), e arrastá-la não é pedir para responder.
 */
export const CONTROLES_QUE_NAO_INICIAM_O_GESTO =
  "input, button, a, audio, video, textarea, select, [role='slider'], [data-sem-deslizar]";
