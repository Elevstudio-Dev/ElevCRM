import { describe, expect, it } from "vitest";

import { corDaEtapa } from "./cor-da-etapa";

const aberta = { color: null, is_won: false, is_lost: false } as const;

describe("corDaEtapa", () => {
  it("a cor que o operador escolheu sempre vence", () => {
    expect(corDaEtapa({ color: "#ff8800", is_won: false, is_lost: false }, 0, 3)).toBe("#ff8800");
    // …mesmo numa etapa de ganho ou de perda: é dado dele, não padrão nosso.
    expect(corDaEtapa({ color: "#123456", is_won: true, is_lost: false }, 0, 3)).toBe("#123456");
    expect(corDaEtapa({ color: "#123456", is_won: false, is_lost: true }, 0, 3)).toBe("#123456");
  });

  it("cor só com espaços não conta como escolhida", () => {
    expect(corDaEtapa({ color: "   ", is_won: false, is_lost: false }, 0, 1)).toMatch(/^var\(--color-accent-\d{3}\)$/);
  });

  it("ganho é verde e perda é vermelha, pelos tokens do tema", () => {
    expect(corDaEtapa({ color: null, is_won: true, is_lost: false }, 0, 3)).toBe("var(--color-success)");
    expect(corDaEtapa({ color: null, is_won: false, is_lost: true }, 0, 3)).toBe("var(--color-error)");
  });

  it("as abertas andam do tom claro da rampa ao escuro, em ordem", () => {
    const graus = [0, 1, 2, 3, 4, 5].map((i) => {
      const m = /--color-accent-(\d{3})/.exec(corDaEtapa(aberta, i, 6));
      return Number(m?.[1]);
    });
    expect(graus).toEqual([300, 400, 500, 600, 700, 800]);
  });

  it("com poucas etapas, abre no claro e fecha no escuro (não amontoa no meio)", () => {
    expect(corDaEtapa(aberta, 0, 3)).toBe("var(--color-accent-300)");
    expect(corDaEtapa(aberta, 2, 3)).toBe("var(--color-accent-800)");
    expect(corDaEtapa(aberta, 1, 3)).toMatch(/--color-accent-(500|600)\)$/);
  });

  it("uma etapa aberta só fica no meio da rampa", () => {
    expect(corDaEtapa(aberta, 0, 1)).toMatch(/--color-accent-(500|600)\)$/);
  });

  it("índice fora da faixa não quebra (prende nas pontas)", () => {
    expect(corDaEtapa(aberta, -2, 4)).toBe("var(--color-accent-300)");
    expect(corDaEtapa(aberta, 99, 4)).toBe("var(--color-accent-800)");
    expect(corDaEtapa(aberta, 0, 0)).toMatch(/^var\(--color-accent-\d{3}\)$/);
  });

  it("só emite var(--…) — nenhum hex que não siga o tema", () => {
    for (let n = 1; n <= 8; n += 1) {
      for (let i = 0; i < n; i += 1) {
        expect(corDaEtapa(aberta, i, n)).toMatch(/^var\(--color-accent-(300|400|500|600|700|800)\)$/);
      }
    }
  });
});
