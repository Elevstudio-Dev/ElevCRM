import { describe, expect, it } from "vitest";

import { buildTemporalBlock, followupTurnPayloadSchema } from "@/lib/agent-engine/agent/followup-turn";

/**
 * O RETORNO MARCADO POR UMA PESSOA chega ao turno do agente como ORDEM da equipe.
 *
 * Dois fatos que quebrariam em silêncio: (1) o retorno de uma pessoa grava `promise: null` — o schema do payload só
 * aceitava texto, e o turno do dia morreria no parse, sem nunca falar com o cliente; (2) a instrução precisa aparecer
 * no bloco que o modelo lê, e como instrução, não como "você prometeu".
 */
const AGORA = new Date("2026-11-20T12:00:00Z");

describe("payload do turno de follow-up", () => {
  it("aceita o retorno de uma pessoa: promise nula e a instrução da equipe", () => {
    const r = followupTurnPayloadSchema.safeParse({
      reason: "perguntar se decidiu",
      promise: null,
      promised_at: "2026-11-20T12:00:00Z",
      instruction: "perguntar se decidiu pelo clareamento",
      source: "human",
    });
    expect(r.success).toBe(true);
  });

  it("o retorno que o agente marcou (promise em texto, sem instrução) continua valendo", () => {
    const r = followupTurnPayloadSchema.safeParse({ reason: "r", promise: "te chamo quarta", promised_at: "x" });
    expect(r.success).toBe(true);
  });
});

describe("buildTemporalBlock — instrução da equipe", () => {
  const ultima = { body: "vou pensar", sentAt: "2026-11-13T12:00:00Z" };

  it("entrega a instrução como ordem, com as palavras da pessoa", () => {
    const bloco = buildTemporalBlock({
      now: AGORA,
      reason: "perguntar se decidiu",
      promise: null,
      instruction: "perguntar se decidiu pelo clareamento e oferecer sábado",
      lastInbound: ultima,
    });
    expect(bloco).toContain("INSTRUÇÃO DA EQUIPE PARA ESTE RETORNO");
    expect(bloco).toContain("perguntar se decidiu pelo clareamento e oferecer sábado");
    expect(bloco).toContain("Passaram 7 dias");
  });

  it("sem promessa não inventa 'você prometeu' — ninguém prometeu nada ao cliente", () => {
    const bloco = buildTemporalBlock({ now: AGORA, promise: null, instruction: "ligar", lastInbound: ultima });
    expect(bloco).not.toContain("Você prometeu");
  });

  it("sem instrução, o bloco é o de sempre", () => {
    const bloco = buildTemporalBlock({ now: AGORA, reason: "r", promise: "p", lastInbound: ultima });
    expect(bloco).not.toContain("INSTRUÇÃO DA EQUIPE");
    expect(bloco).toContain("Você prometeu: p.");
  });

  it("instrução só com espaços não vira ordem vazia", () => {
    const bloco = buildTemporalBlock({ now: AGORA, instruction: "   ", lastInbound: null });
    expect(bloco).not.toContain("INSTRUÇÃO DA EQUIPE");
  });
});
