import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { BEFORE_SEND_GATES, type GateContext } from "@/lib/agent-engine/guardrails/before-send";

/**
 * O VETO FINAL: ninguém que está "fora do funil" recebe mensagem do agente — mesmo que uma porta anterior (drain,
 * turno, follow-up) deixe passar. É a defesa em profundidade do `decidirElegibilidade`.
 *
 * O código do veto é PRÓPRIO (`contato_fora_do_funil`): o do opt-out diz "o lead optou por sair", e dizer isso de
 * um prestador de serviço seria uma mentira escrita no trace.
 */
const stop = BEFORE_SEND_GATES.find((g) => g.name === "stop")!;

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-10-29T12:00:00Z"),
    body: "oi",
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
      rng: () => 0,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    lgpd: null,
    promise: { table: null },
    semanticPromise: null,
    ...over,
  } as GateContext;
}

describe("o gate 'stop' e o contato fora do funil", () => {
  it("existe e é o primeiro da cadeia", () => {
    expect(stop).toBeDefined();
    expect(BEFORE_SEND_GATES[0]).toBe(stop);
  });

  it("contato do funil e sem opt-out: passa", () => {
    expect(stop.evaluate(ctx()).pass).toBe(true);
  });

  it("fora do funil: veta com o código PRÓPRIO, e o motivo não fala em opt-out", () => {
    const v = stop.evaluate(ctx({ foraDoFunil: true }));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("contato_fora_do_funil");
    expect(v.reason).not.toMatch(/optou|opt-out|sair do atendimento/i);
    expect(v.reason).toMatch(/fora do funil/i);
  });

  it("opt-out continua com o código dele, mesmo se a pessoa também estiver fora do funil (o legal vem primeiro)", () => {
    const v = stop.evaluate(ctx({ optedOut: true, foraDoFunil: true }));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("contato_bloqueado");
  });

  it("o runner LÊ a coluna do marcador do banco (sem isto o veto seria letra morta)", () => {
    const fonte = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");
    expect(fonte).toContain("fora_do_funil_em is not null");
    expect(fonte).toMatch(/foraDoFunil[,:]/);
  });
});
