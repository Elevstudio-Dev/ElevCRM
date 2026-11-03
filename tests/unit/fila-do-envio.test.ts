import { describe, expect, it } from "vitest";

import { ficouNaFila, motivoDaFila } from "@/lib/inbox/fila-do-envio";

describe("ficouNaFila — a bolha precisa dizer que a mensagem não saiu", () => {
  it("nossa e na fila, já passou pelo servidor: sim", () => {
    expect(ficouNaFila({ direction: "outbound", status: "queued", metadata: { queued_reason: "x" } })).toBe(true);
    expect(ficouNaFila({ direction: "outbound", status: "queued" })).toBe(true);
  });

  it("a bolha otimista (ainda saindo) NÃO é aviso — senão toda mensagem piscaria 'não saiu'", () => {
    expect(ficouNaFila({ direction: "outbound", status: "queued", metadata: { _optimistic: true } })).toBe(false);
  });

  it("enviada, falhada ou do cliente: não", () => {
    for (const status of ["sent", "delivered", "read", "failed"]) {
      expect(ficouNaFila({ direction: "outbound", status })).toBe(false);
    }
    expect(ficouNaFila({ direction: "inbound", status: "queued" })).toBe(false);
  });
});

describe("motivoDaFila — o que o envio gravou", () => {
  it("número desconectado", () => {
    expect(motivoDaFila({ queued_reason: "channel_session_not_working" })).toBe("numero_desconectado");
  });

  it("canal sem configuração, de qualquer canal", () => {
    expect(motivoDaFila({ queued_reason: "waha_not_configured" })).toBe("canal_nao_configurado");
    expect(motivoDaFila({ queued_reason: "meta_not_configured" })).toBe("canal_nao_configurado");
  });

  it("sem motivo, ou motivo que não conhece: genérico — nunca inventa uma causa", () => {
    expect(motivoDaFila(undefined)).toBe("desconhecido");
    expect(motivoDaFila(null)).toBe("desconhecido");
    expect(motivoDaFila({})).toBe("desconhecido");
    expect(motivoDaFila({ queued_reason: 42 })).toBe("desconhecido");
    expect(motivoDaFila({ queued_reason: "qualquer_outra_coisa" })).toBe("desconhecido");
  });
});
