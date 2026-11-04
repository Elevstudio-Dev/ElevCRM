/**
 * Decide o que um ack do WAHA pode fazer com uma mensagem que já existe.
 *
 * O ack é um EVENTO, e eventos chegam fora de ordem (ou repetidos). O estado da
 * mensagem, ao contrário, só anda para a frente:
 *
 *   queued → sending → sent → delivered → read
 *
 * Antes, `handleAck` gravava `{ack, status}` por cima do que estivesse lá: um
 * "servidor recebeu" (1) atrasado regredia um "lido" (3) para "enviada", e o
 * tique azul sumia da tela sem ninguém ter feito nada.
 *
 * A falha (`failed`) é a única exceção à régua — e é regrada à parte:
 *   - vence `sending` e `sent` (ainda não há prova de que chegou ao aparelho);
 *   - NÃO vence `delivered`/`read` (a mensagem chegou; um -1 depois disso é
 *     ruído, e marcar falha numa mensagem que o cliente leu faria o atendente
 *     reenviar e o cliente receber duas vezes);
 *   - só sai de `failed` por prova de ENTREGA (2/3/4): uma mensagem que o cron
 *     deu por perdida e que depois mostra ack de aparelho chegou, de fato.
 *     0 e 1 não bastam — não provam o aparelho.
 *
 * Exceção da exceção — GRUPO: lá o -1 NÃO é falha. Medido na VPS (04/11/2026): das 14 mensagens de atendente em
 * grupo, nenhuma recebeu ack 1/2/3 (só -1 ou 0), e o dono confirmou no celular que elas CHEGARAM (algumas foram
 * lidas); em 1:1 os acks andam 1→2→3. O NOWEB não dá o ack de recibo por mensagem em grupo, e o -1 que ele manda
 * ali é ruído. Chamar isso de "Falhou" faz o atendente reenviar e o grupo receber duas vezes. Em grupo, o -1 só
 * prova que o WAHA conhece a mensagem: ela sobe para `sent` e nada é anunciado.
 *
 * Função pura de propósito: a regra se testa sem banco, e `handleAck` só a
 * executa.
 */
import { ackToStatus } from "@/lib/types/messaging";

/** Posição na régua. `failed` não está aqui: não é um ponto da régua, é desvio. */
const POSICAO: Record<string, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

export interface LinhaDoAck {
  direction: string | null;
  status: string | null;
  /** A conversa é um grupo (o chat do ack termina em `@g.us`). Sem a informação, vale a regra de 1:1. */
  grupo?: boolean;
}

export type DecisaoDoAck =
  | { aplicar: false }
  | {
      aplicar: true;
      /** Status que o ack leva a mensagem a ter. */
      status: ReturnType<typeof ackToStatus>;
      /** `true` quando a mensagem estava `failed` e a prova de entrega a desfaz. */
      cura: boolean;
    };

export function decidirAck(linha: LinhaDoAck, ack: number): DecisaoDoAck {
  const novo = ackToStatus(ack);

  // Linha que não é saída nossa (`received` etc.) nunca "falha" por ack — não
  // há envio nosso para ter falhado. Para o resto, o comportamento é o de
  // sempre: este conserto é sobre as mensagens que o CRM enviou.
  if (linha.direction !== "outbound") {
    return novo === "failed" ? { aplicar: false } : { aplicar: true, status: novo, cura: false };
  }

  const atual = linha.status ?? "";

  if (novo === "failed" && linha.grupo) {
    // Ruído do NOWEB em grupo (ver o cabeçalho): nunca é falha. Quem ainda não saiu da fila de envio passa a `sent`.
    return atual === "sending" || atual === "queued"
      ? { aplicar: true, status: "sent", cura: false }
      : { aplicar: false };
  }

  if (novo === "failed") {
    return atual === "sending" || atual === "sent"
      ? { aplicar: true, status: "failed", cura: false }
      : { aplicar: false };
  }

  if (atual === "failed") {
    return novo === "delivered" || novo === "read"
      ? { aplicar: true, status: novo, cura: true }
      : { aplicar: false };
  }

  const de = POSICAO[atual];
  const para = POSICAO[novo];
  // Status que a régua não conhece: não adivinhar. Calar é o desfecho seguro —
  // um ack não deve reescrever um estado que ninguém sabe ler.
  if (de === undefined || para === undefined) return { aplicar: false };
  return para > de ? { aplicar: true, status: novo, cura: false } : { aplicar: false };
}
