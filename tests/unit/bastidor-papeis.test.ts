import { describe, expect, it } from "vitest";

import {
  PAPEIS_INTERNOS,
  TIPOS_DE_MENSAGEM_DO_BASTIDOR,
  ehPapelInterno,
  papelPermiteTipo,
  type TipoDeMensagemDoBastidor,
} from "@/lib/bastidor/papeis";

/**
 * OS PAPÉIS DE CONTATO — secretaria e marketing.
 *
 * Quem tem papel é da equipe: o agente de VENDAS nunca escreve para ele. O agente de BASTIDOR escreve, mas só o
 * que o papel comporta: a secretaria recebe pergunta de agenda, o marketing recebe prévia de campanha. Pergunta de
 * agenda para o contato de marketing (ou o contrário) é erro de roteamento e o veto tem de pegar.
 */
describe("os papéis internos", () => {
  it("são exatamente dois, e a lista é a fonte única", () => {
    expect([...PAPEIS_INTERNOS]).toEqual(["secretaria", "marketing"]);
  });

  it("ehPapelInterno só aceita os dois valores exatos", () => {
    expect(ehPapelInterno("secretaria")).toBe(true);
    expect(ehPapelInterno("marketing")).toBe(true);
    expect(ehPapelInterno("Secretaria")).toBe(false);
    expect(ehPapelInterno("admin")).toBe(false);
    expect(ehPapelInterno("")).toBe(false);
    expect(ehPapelInterno(null)).toBe(false);
    expect(ehPapelInterno(undefined)).toBe(false);
    expect(ehPapelInterno(7)).toBe(false);
  });
});

describe("papelPermiteTipo", () => {
  it("a secretaria recebe os tipos de agenda e reserva", () => {
    for (const tipo of TIPOS_DE_MENSAGEM_DO_BASTIDOR.secretaria) {
      expect(papelPermiteTipo("secretaria", tipo)).toBe(true);
    }
  });

  it("o marketing recebe os tipos de campanha", () => {
    for (const tipo of TIPOS_DE_MENSAGEM_DO_BASTIDOR.marketing) {
      expect(papelPermiteTipo("marketing", tipo)).toBe(true);
    }
  });

  it("um papel NÃO recebe os tipos do outro (roteamento errado vira veto)", () => {
    for (const tipo of TIPOS_DE_MENSAGEM_DO_BASTIDOR.marketing) {
      expect(papelPermiteTipo("secretaria", tipo)).toBe(false);
    }
    for (const tipo of TIPOS_DE_MENSAGEM_DO_BASTIDOR.secretaria) {
      expect(papelPermiteTipo("marketing", tipo)).toBe(false);
    }
  });

  it("sem papel (contato comum, prestador, nulo) nenhum tipo passa", () => {
    const todos = [
      ...TIPOS_DE_MENSAGEM_DO_BASTIDOR.secretaria,
      ...TIPOS_DE_MENSAGEM_DO_BASTIDOR.marketing,
    ] as TipoDeMensagemDoBastidor[];
    for (const tipo of todos) {
      expect(papelPermiteTipo(null, tipo)).toBe(false);
      expect(papelPermiteTipo(undefined, tipo)).toBe(false);
    }
  });

  it("os tipos de papéis diferentes não se repetem (senão o veto não distinguiria)", () => {
    const s = new Set<string>(TIPOS_DE_MENSAGEM_DO_BASTIDOR.secretaria);
    for (const t of TIPOS_DE_MENSAGEM_DO_BASTIDOR.marketing) expect(s.has(t)).toBe(false);
  });
});
