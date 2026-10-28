/**
 * O QUE A ATENDENTE VÊ EMBAIXO DE UM ÁUDIO DO CLIENTE.
 *
 * O agente de IA sempre leu a transcrição; a atendente nunca. Quem abria a
 * conversa tinha de ouvir cada áudio inteiro — no ônibus, no meio de outro
 * atendimento — para saber do que se tratava, enquanto o sistema já tinha o
 * texto pronto, guardado em `messages.media_derived_text`.
 *
 * Esta função decide QUAL dos cinco estados mostrar. É pura de propósito: o que
 * a tela diz sobre uma transcrição é uma afirmação sobre a mensagem do cliente,
 * e errar aqui é pior que não mostrar — dizer "Transcrevendo…" para sempre,
 * "falhou" para o que nunca foi tentado, ou exibir o marcador interno do
 * sistema como se o cliente tivesse dito aquilo.
 */
import { MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";

/** Só o que a decisão lê da mensagem (a mensagem inteira não é necessária). */
export interface MensagemParaTranscricao {
  type: string;
  direction: "inbound" | "outbound";
  media_derived_text?: string | null;
  media_derived_status?: string | null;
  created_at: string;
}

export type EstadoDaTranscricao =
  | { tipo: "nenhuma" }
  | { tipo: "em_andamento" }
  | { tipo: "pronta"; texto: string }
  | { tipo: "sem_fala" }
  | { tipo: "indisponivel" };

/**
 * Por quanto tempo "ainda não deu tempo" é uma resposta honesta.
 *
 * Medido numa instalação real: da chegada do áudio ao texto pronto levam de
 * ~20 s a 3 min (o download, a fila e os 4 s do Whisper). O drain tenta até 5
 * vezes antes de marcar `failed`, então 10 min cobre o caso ruim com folga.
 * Passado isso sem estado nenhum, a mensagem simplesmente nunca foi para
 * derivação (áudio antigo, canal sem mídia de entrada) — e a tela não diz nada,
 * em vez de prometer uma transcrição que não virá.
 */
export const JANELA_DE_ESPERA_MS = 10 * 60 * 1000;

export function estadoDaTranscricao(
  m: MensagemParaTranscricao,
  agora: number = Date.now(),
): EstadoDaTranscricao {
  // Só o áudio que ENTRA. O que a atendente grava é dela — ela sabe o que disse,
  // e esse áudio nunca vai para a derivação.
  if (m.type !== "audio" || m.direction !== "inbound") return { tipo: "nenhuma" };

  const status = m.media_derived_status ?? null;

  if (status === "failed") return { tipo: "indisponivel" };

  if (status === "ready") {
    const texto = (m.media_derived_text ?? "").trim();
    // O worker grava o marcador como derivado `ready` (é o que o agente lê). Para
    // a atendente isso é "não deu para transcrever", não uma fala do cliente.
    if (texto === MARCADOR_NAO_LIDA) return { tipo: "indisponivel" };
    // O Whisper devolve vazio para silêncio, ruído ou música. Isso é uma
    // transcrição que deu certo e achou nada — diferente de falha.
    if (!texto) return { tipo: "sem_fala" };
    return { tipo: "pronta", texto };
  }

  const chegou = Date.parse(m.created_at);
  if (Number.isFinite(chegou) && agora - chegou < JANELA_DE_ESPERA_MS) {
    return { tipo: "em_andamento" };
  }
  return { tipo: "nenhuma" };
}
