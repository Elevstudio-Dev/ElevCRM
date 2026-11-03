/**
 * `ackToStatus` + `decidirAck`: a tabela do ack do WAHA, valor por valor.
 *
 *   -1 ERROR · 0 PENDING · 1 SERVER · 2 DEVICE · 3 READ · 4 PLAYED
 *
 * O -1 caía no último `return "sending"` (a função só conhecia 0..3). O efeito
 * em produção está contado em `waha-ack-erro-e-guarda-monotonica.test.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";
import { ACK_ERRO_DO_CANAL, ackToStatus } from "@/lib/types/messaging";
import { decidirAck } from "@/lib/waha/ack";

describe("ackToStatus — cada valor do WAHA", () => {
  it.each([
    [-1, "failed"],
    [0, "sending"],
    [1, "sent"],
    [2, "delivered"],
    [3, "read"],
    [4, "read"], // PLAYED (áudio ouvido) é mais que lido
  ] as const)("ack %i → %s", (ack, status) => {
    expect(ackToStatus(ack)).toBe(status);
  });

  it("ack negativo NUNCA vira 'sending' (era o defeito: o relógio ficava rodando até o cron inventar um timeout)", () => {
    for (const ack of [-1, -2, -100]) {
      expect(ackToStatus(ack)).not.toBe("sending");
      expect(ackToStatus(ack)).toBe("failed");
    }
  });

  it("sem ack (null/undefined) continua 'sent' — o resto do mapa não mudou", () => {
    expect(ackToStatus(null)).toBe("sent");
    expect(ackToStatus(undefined)).toBe("sent");
  });
});

describe("o texto do erro", () => {
  it("tem código próprio (não é o send_timeout do cron) e diz em português que o WhatsApp não confirmou", () => {
    expect(ACK_ERRO_DO_CANAL.code).toBe("waha_ack_error");
    expect(ACK_ERRO_DO_CANAL.code).not.toBe("send_timeout");
    expect(ACK_ERRO_DO_CANAL.message).toMatch(/WhatsApp/);
    expect(ACK_ERRO_DO_CANAL.message).toMatch(/não confirmou/i);
  });

  it("o espanhol cobre o texto novo (a bolha o mostra por t())", () => {
    const es = traduzir(ACK_ERRO_DO_CANAL.message, "es");
    expect(es).not.toBe(ACK_ERRO_DO_CANAL.message);
    expect(es).toMatch(/WhatsApp/);
  });

  it("a bolha troca o texto gravado pelo traduzido quando o código é o do ack", () => {
    const fonte = readFileSync(resolve(__dirname, "../../components/inbox/MessageBubble.tsx"), "utf-8");
    expect(fonte).toContain("ACK_ERRO_DO_CANAL.code");
    expect(fonte).toContain(`t("${ACK_ERRO_DO_CANAL.message}")`);
  });
});

describe("decidirAck — a regra pura, sem banco", () => {
  const out = (status: string, ack: number) => decidirAck({ direction: "outbound", status }, ack);

  it("avançar aplica; empatar ou recuar não", () => {
    expect(out("queued", 0)).toMatchObject({ aplicar: true, status: "sending" });
    expect(out("sending", 0)).toMatchObject({ aplicar: false });
    expect(out("sending", 1)).toMatchObject({ aplicar: true, status: "sent" });
    expect(out("sent", 1)).toMatchObject({ aplicar: false });
    expect(out("sent", 2)).toMatchObject({ aplicar: true, status: "delivered" });
    expect(out("delivered", 2)).toMatchObject({ aplicar: false });
    expect(out("delivered", 3)).toMatchObject({ aplicar: true, status: "read" });
    expect(out("read", 3)).toMatchObject({ aplicar: false });
    expect(out("read", 4)).toMatchObject({ aplicar: false });
    expect(out("read", 1)).toMatchObject({ aplicar: false });
  });

  it("falha só vence sending/sent; nunca delivered/read", () => {
    expect(out("sending", -1)).toMatchObject({ aplicar: true, status: "failed" });
    expect(out("sent", -1)).toMatchObject({ aplicar: true, status: "failed" });
    expect(out("delivered", -1)).toMatchObject({ aplicar: false });
    expect(out("read", -1)).toMatchObject({ aplicar: false });
    expect(out("failed", -1)).toMatchObject({ aplicar: false });
  });

  it("failed só sai dele por prova de entrega (2/3/4)", () => {
    expect(out("failed", 0)).toMatchObject({ aplicar: false });
    expect(out("failed", 1)).toMatchObject({ aplicar: false });
    expect(out("failed", 2)).toMatchObject({ aplicar: true, status: "delivered", cura: true });
    expect(out("failed", 3)).toMatchObject({ aplicar: true, status: "read", cura: true });
    expect(out("failed", 4)).toMatchObject({ aplicar: true, status: "read", cura: true });
  });

  it("linha que não é saída nossa nunca vira failed", () => {
    expect(decidirAck({ direction: "inbound", status: "received" }, -1)).toMatchObject({ aplicar: false });
  });
});
