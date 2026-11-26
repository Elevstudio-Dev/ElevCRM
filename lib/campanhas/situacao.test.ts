import { describe, expect, it } from "vitest";

import { MOTIVO_CANCELAMENTO, MOTIVO_PAUSA, NO_GATILHO, situacaoDoDestinatario } from "./situacao";

const ativa = { status: "active", current_node_id: NO_GATILHO, cancel_reason: null };

describe("situacaoDoDestinatario", () => {
  it("antes do envio: agendado, enviando, pausado, cancelado, falhou, conversou antes", () => {
    expect(situacaoDoDestinatario(ativa, null, null, false)).toBe("agendado");
    expect(situacaoDoDestinatario({ ...ativa, current_node_id: "mensagem" }, null, null, false)).toBe("enviando");
    expect(
      situacaoDoDestinatario({ status: "cancelled", current_node_id: NO_GATILHO, cancel_reason: MOTIVO_PAUSA }, null, null, false),
    ).toBe("pausado");
    expect(
      situacaoDoDestinatario(
        { status: "cancelled", current_node_id: NO_GATILHO, cancel_reason: MOTIVO_CANCELAMENTO },
        null,
        null,
        false,
      ),
    ).toBe("cancelado");
    expect(situacaoDoDestinatario({ ...ativa, status: "dead" }, null, null, false)).toBe("falhou");
    expect(
      situacaoDoDestinatario({ status: "completed", current_node_id: NO_GATILHO, cancel_reason: "cancel_on_reply" }, null, null, false),
    ).toBe("conversou_antes");
    expect(situacaoDoDestinatario({ ...ativa, status: "paused_handoff" }, null, null, false)).toBe("pausado");
  });

  it("depois do envio: enviado, respondeu, pediu para sair (que vence o resto)", () => {
    const feita = { status: "completed", current_node_id: "fim", cancel_reason: "campanha_enviada" };
    expect(situacaoDoDestinatario(feita, "2026-11-27T12:00:00Z", null, false)).toBe("enviado");
    expect(situacaoDoDestinatario(feita, "2026-11-27T12:00:00Z", "2026-11-27T12:05:00Z", false)).toBe("respondeu");
    // resposta de ANTES do envio não conta como resposta à campanha
    expect(situacaoDoDestinatario(feita, "2026-11-27T12:00:00Z", "2026-11-27T11:00:00Z", false)).toBe("enviado");
    expect(situacaoDoDestinatario(feita, "2026-11-27T12:00:00Z", "2026-11-27T12:05:00Z", true)).toBe("pediu_para_sair");
  });
});
