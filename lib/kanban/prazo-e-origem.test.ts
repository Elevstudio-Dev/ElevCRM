import { describe, expect, it } from "vitest";

import { origemDoLead, prazoDoCard } from "./prazo-e-origem";

// Meio-dia local: longe o bastante da meia-noite para o fuso do runner não mudar o dia.
const agora = new Date(2026, 9, 28, 12, 0, 0);

describe("prazoDoCard", () => {
  it("sem prazo, o card não diz nada", () => {
    expect(prazoDoCard(null, agora)).toBeNull();
    expect(prazoDoCard(undefined, agora)).toBeNull();
    expect(prazoDoCard("", agora)).toBeNull();
  });

  it("data inválida não vira 'Fecha em NaN dias'", () => {
    expect(prazoDoCard("não é data", agora)).toBeNull();
  });

  it("hoje, amanhã e adiante", () => {
    expect(prazoDoCard("2026-10-28", agora)).toMatchObject({ faixa: "hoje", dias: 0, texto: "Fecha hoje" });
    expect(prazoDoCard("2026-10-29", agora)).toMatchObject({ faixa: "proximo", dias: 1, texto: "Fecha amanhã" });
    expect(prazoDoCard("2026-10-31", agora)).toMatchObject({ faixa: "proximo", dias: 3, texto: "Fecha em 3 dias" });
    expect(prazoDoCard("2026-11-10", agora)).toMatchObject({ faixa: "folga", dias: 13, texto: "Fecha em 13 dias" });
  });

  it("passou: vermelho, com o singular certo", () => {
    expect(prazoDoCard("2026-10-27", agora)).toMatchObject({ faixa: "atrasado", dias: -1, texto: "Atrasado há 1 dia" });
    expect(prazoDoCard("2026-10-20", agora)).toMatchObject({ faixa: "atrasado", dias: -8, texto: "Atrasado há 8 dias" });
  });

  it("conta dias de CALENDÁRIO: às 23h59 de hoje, 'amanhã' continua sendo amanhã", () => {
    const tarde = new Date(2026, 9, 28, 23, 59, 0);
    expect(prazoDoCard("2026-10-29", tarde)?.dias).toBe(1);
    const cedo = new Date(2026, 9, 28, 0, 1, 0);
    expect(prazoDoCard("2026-10-28", cedo)?.dias).toBe(0);
  });

  it("traduz pelo `t` recebido", () => {
    const t = (s: string) => (s === "Fecha hoje" ? "Cierra hoy" : s);
    expect(prazoDoCard("2026-10-28", agora, t)?.texto).toBe("Cierra hoy");
  });
});

describe("origemDoLead", () => {
  it("sem origem, nada", () => {
    expect(origemDoLead(null)).toBeNull();
    expect(origemDoLead("   ")).toBeNull();
  });

  it("os valores que o produto grava", () => {
    expect(origemDoLead("manual")).toEqual({ icone: "manual", rotulo: "Manual" });
    expect(origemDoLead("import")).toMatchObject({ icone: "importada", rotulo: "Importado" });
    expect(origemDoLead("ai_agent")).toMatchObject({ icone: "agente", rotulo: "Agente de IA" });
    expect(origemDoLead("reactivation")).toMatchObject({ icone: "agente", rotulo: "Retomada" });
  });

  it("não diferencia maiúscula de minúscula", () => {
    expect(origemDoLead("MANUAL")?.icone).toBe("manual");
  });

  it("texto livre desconhecido aparece legível, não escondido", () => {
    expect(origemDoLead("landing_page")).toEqual({ icone: "outra", rotulo: "Landing page" });
  });
});
