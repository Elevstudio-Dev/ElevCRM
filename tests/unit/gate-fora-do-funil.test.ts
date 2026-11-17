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

/**
 * O PAPEL ABRE UMA PORTA ESTREITA: só o agente de BASTIDOR, só para quem tem papel, só com um tipo que o papel
 * comporta. O agente de vendas, o follow-up e o aviso de escalação não preenchem `bastidor` e continuam vetados.
 */
describe("o gate 'stop' e os papéis de contato (secretaria, marketing)", () => {
  it("vendas (sem `bastidor`) NÃO fala com a secretaria: o veto de fora do funil vale", () => {
    const v = stop.evaluate(ctx({ foraDoFunil: true, papelInterno: "secretaria" }));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("contato_fora_do_funil");
  });

  it("bastidor, para a secretaria, com tipo de agenda: passa", () => {
    const v = stop.evaluate(
      ctx({ foraDoFunil: true, papelInterno: "secretaria", bastidor: { tipo: "agenda_pergunta" } }),
    );
    expect(v.pass).toBe(true);
  });

  it("bastidor, para o marketing, com tipo de campanha: passa", () => {
    const v = stop.evaluate(
      ctx({ foraDoFunil: true, papelInterno: "marketing", bastidor: { tipo: "campanha_previa" } }),
    );
    expect(v.pass).toBe(true);
  });

  it("tipo do papel errado (pergunta de agenda ao marketing) é vetado", () => {
    const v = stop.evaluate(
      ctx({ foraDoFunil: true, papelInterno: "marketing", bastidor: { tipo: "agenda_pergunta" } }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("contato_fora_do_funil");
  });

  it("bastidor para contato SEM papel (um paciente, um prestador) é vetado com código próprio", () => {
    for (const papelInterno of [null, undefined] as const) {
      const v = stop.evaluate(ctx({ foraDoFunil: false, papelInterno, bastidor: { tipo: "agenda_pergunta" } }));
      expect(v.pass).toBe(false);
      if (v.pass) throw new Error("inalcançável");
      expect(v.code).toBe("bastidor_destinatario_invalido");
    }
    const prestador = stop.evaluate(ctx({ foraDoFunil: true, papelInterno: null, bastidor: { tipo: "agenda_pergunta" } }));
    expect(prestador.pass).toBe(false);
    if (prestador.pass) throw new Error("inalcançável");
    expect(prestador.code).toBe("bastidor_destinatario_invalido");
  });

  it("opt-out vence o papel: quem pediu para parar não recebe nem do bastidor", () => {
    const v = stop.evaluate(
      ctx({
        optedOut: true,
        foraDoFunil: true,
        papelInterno: "secretaria",
        bastidor: { tipo: "agenda_pergunta" },
      }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("contato_bloqueado");
  });

  it("o runner LÊ o papel do banco e só repassa `bastidor` de quem o pediu", () => {
    const fonte = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");
    expect(fonte).toContain("papel_interno as papel");
    expect(fonte).toMatch(/args\.bastidor !== undefined \? \{ bastidor: args\.bastidor \}/);
  });
});
