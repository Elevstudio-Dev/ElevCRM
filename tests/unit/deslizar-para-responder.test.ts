/**
 * O GESTO DE DESLIZAR PARA RESPONDER — o que o separa de uma rolagem.
 *
 * A conversa rola na vertical com o dedo no mesmo lugar em que o gesto começa. Se um dedo que desce 30px
 * e anda 10px para o lado contar como "responder", a lista pula de resposta em resposta a cada rolada. A
 * regra é a DIREÇÃO, e é o que este arquivo guarda.
 */
import { describe, expect, it } from "vitest";

import {
  DESLOCAMENTO_MAXIMO,
  LIMIAR_PARA_RESPONDER,
  lerGesto,
  soltouParaResponder,
} from "@/lib/inbox/deslizar-para-responder";

describe("lerGesto", () => {
  it("o dedo que treme ainda não diz nada", () => {
    expect(lerGesto(0, 0).estado).toBe("indeciso");
    expect(lerGesto(5, 3).estado).toBe("indeciso");
    expect(lerGesto(-4, 2).estado).toBe("indeciso");
  });

  it("claramente horizontal para a DIREITA é o deslize, e a bolha acompanha", () => {
    expect(lerGesto(30, 2)).toEqual({ estado: "deslizando", deslocamento: 30 });
    expect(lerGesto(60, 20)).toEqual({ estado: "deslizando", deslocamento: 60 });
  });

  it("a bolha para de andar no máximo, mas o limiar já foi passado", () => {
    expect(lerGesto(300, 0)).toEqual({ estado: "deslizando", deslocamento: DESLOCAMENTO_MAXIMO });
    expect(DESLOCAMENTO_MAXIMO).toBeGreaterThan(LIMIAR_PARA_RESPONDER);
  });

  it("vertical é ROLAGEM, mesmo com um pouco de movimento lateral", () => {
    expect(lerGesto(10, 60).estado).toBe("rolagem");
    expect(lerGesto(25, 40).estado).toBe("rolagem");
    expect(lerGesto(0, -50).estado).toBe("rolagem");
  });

  it("diagonal que não é claramente horizontal NÃO responde (o dedo desceu tanto quanto andou)", () => {
    // dx=40, dy=30: horizontal demais para ser rolagem declarada, vertical demais para ser deslize.
    expect(lerGesto(40, 30).estado).not.toBe("deslizando");
  });

  it("para a ESQUERDA não é o gesto (fica livre para outro uso)", () => {
    expect(lerGesto(-60, 2).estado).toBe("rolagem");
  });
});

describe("soltouParaResponder", () => {
  it("só vale a partir do limiar", () => {
    expect(soltouParaResponder(LIMIAR_PARA_RESPONDER - 1)).toBe(false);
    expect(soltouParaResponder(LIMIAR_PARA_RESPONDER)).toBe(true);
    expect(soltouParaResponder(DESLOCAMENTO_MAXIMO)).toBe(true);
    expect(soltouParaResponder(0)).toBe(false);
  });
});
