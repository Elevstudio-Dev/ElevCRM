/**
 * O QUE A TELA AFIRMA SOBRE A TRANSCRIÇÃO DE UM ÁUDIO.
 *
 * Cada estado é uma frase dita à atendente sobre a mensagem do cliente, e os
 * erros que importam são os que mentem: "Transcrevendo…" para um áudio que
 * nunca foi para a fila, "falhou" para o que nem foi tentado, ou o marcador
 * interno do sistema exibido como fala do cliente.
 */
import { describe, expect, it } from "vitest";

import { MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";
import {
  estadoDaTranscricao,
  JANELA_DE_ESPERA_MS,
  type MensagemParaTranscricao,
} from "@/lib/messaging/media/transcricao-na-conversa";

const AGORA = Date.parse("2026-10-27T15:00:00.000Z");
const HA = (ms: number) => new Date(AGORA - ms).toISOString();

function audio(over: Partial<MensagemParaTranscricao> = {}): MensagemParaTranscricao {
  return {
    type: "audio",
    direction: "inbound",
    media_derived_text: null,
    media_derived_status: null,
    created_at: HA(30_000),
    ...over,
  };
}

describe("estadoDaTranscricao", () => {
  it("pronta: devolve o texto sem as sobras de espaço", () => {
    expect(
      estadoDaTranscricao(
        audio({ media_derived_status: "ready", media_derived_text: "  Oi, quero marcar uma limpeza.\n" }),
        AGORA,
      ),
    ).toEqual({ tipo: "pronta", texto: "Oi, quero marcar uma limpeza." });
  });

  it("o marcador interno NUNCA é mostrado como fala do cliente", () => {
    // O worker grava o marcador como derivado `ready` (é o que o agente lê).
    // Para a atendente isso é "não deu para transcrever".
    expect(
      estadoDaTranscricao(
        audio({ media_derived_status: "ready", media_derived_text: MARCADOR_NAO_LIDA }),
        AGORA,
      ),
    ).toEqual({ tipo: "indisponivel" });
  });

  it("pronta mas vazia: é 'sem fala' (silêncio/ruído), não falha", () => {
    expect(
      estadoDaTranscricao(audio({ media_derived_status: "ready", media_derived_text: "   " }), AGORA),
    ).toEqual({ tipo: "sem_fala" });
    expect(
      estadoDaTranscricao(audio({ media_derived_status: "ready", media_derived_text: null }), AGORA),
    ).toEqual({ tipo: "sem_fala" });
  });

  it("failed: indisponível", () => {
    expect(estadoDaTranscricao(audio({ media_derived_status: "failed" }), AGORA)).toEqual({
      tipo: "indisponivel",
    });
  });

  it("recém-chegado e sem estado: em andamento", () => {
    expect(estadoDaTranscricao(audio({ created_at: HA(5_000) }), AGORA)).toEqual({
      tipo: "em_andamento",
    });
  });

  it("a janela de espera tem fim: passada, não afirma nada (nem 'transcrevendo' nem 'falhou')", () => {
    expect(
      estadoDaTranscricao(audio({ created_at: HA(JANELA_DE_ESPERA_MS - 1_000) }), AGORA),
    ).toEqual({ tipo: "em_andamento" });
    expect(
      estadoDaTranscricao(audio({ created_at: HA(JANELA_DE_ESPERA_MS + 1_000) }), AGORA),
    ).toEqual({ tipo: "nenhuma" });
  });

  it("data ilegível não vira 'transcrevendo' eterno", () => {
    expect(estadoDaTranscricao(audio({ created_at: "não é data" }), AGORA)).toEqual({
      tipo: "nenhuma",
    });
  });

  it("o áudio que a ATENDENTE mandou não tem transcrição na tela", () => {
    expect(
      estadoDaTranscricao(
        audio({ direction: "outbound", media_derived_status: "ready", media_derived_text: "algo" }),
        AGORA,
      ),
    ).toEqual({ tipo: "nenhuma" });
  });

  it("outros tipos de mídia não entram (imagem, documento, texto)", () => {
    for (const type of ["image", "document", "video", "text", "sticker"]) {
      expect(
        estadoDaTranscricao(
          audio({ type, media_derived_status: "ready", media_derived_text: "descrição" }),
          AGORA,
        ),
      ).toEqual({ tipo: "nenhuma" });
    }
  });
});
