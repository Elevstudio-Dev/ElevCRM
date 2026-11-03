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
