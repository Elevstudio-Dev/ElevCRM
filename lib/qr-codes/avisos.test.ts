import { describe, expect, it } from "vitest";

import { avisosDoQr, canalQueAtendeOQr, LIMIAR_DE_LEITURAS_SEM_CONVERSA } from "./avisos";

describe("canalQueAtendeOQr", () => {
  const A = { id: "a", telefone: "+5511900000001", conectado: false };
  const B = { id: "b", telefone: "+5511900000002", conectado: true };
  const SEM_FONE = { id: "c", telefone: null, conectado: true };

  it("o canal escolhido vale, mesmo desconectado", () => {
    expect(canalQueAtendeOQr("a", [A, B])).toBe(A);
  });
  it("canal escolhido sem telefone cai no primeiro conectado com telefone", () => {
    expect(canalQueAtendeOQr("c", [SEM_FONE, A, B])).toBe(B);
  });
  it("canal apagado (null) também cai no primeiro conectado com telefone", () => {
    expect(canalQueAtendeOQr(null, [A, B])).toBe(B);
  });
  it("nada serve: null", () => {
    expect(canalQueAtendeOQr(null, [A, SEM_FONE])).toBeNull();
    expect(canalQueAtendeOQr("a", [])).toBeNull();
  });
});

describe("avisosDoQr", () => {
  it("o limiar é 10 leituras", () => {
    expect(LIMIAR_DE_LEITURAS_SEM_CONVERSA).toBe(10);
  });

  it("9 leituras e nenhuma conversa ainda é cedo: sem aviso", () => {
    expect(avisosDoQr({ leituras: 9, conversas: 0, temNumero: true })).toEqual([]);
  });

  it("10 leituras e nenhuma conversa: o código pode estar sendo apagado ou o número está errado", () => {
    expect(avisosDoQr({ leituras: 10, conversas: 0, temNumero: true })).toEqual(["leituras_sem_conversa"]);
  });

  it("10 leituras e UMA conversa: o QR funciona, sem aviso", () => {
    expect(avisosDoQr({ leituras: 10, conversas: 1, temNumero: true })).toEqual([]);
  });

  it("sem número ligado: avisa, e só isso quando não há leitura", () => {
    expect(avisosDoQr({ leituras: 0, conversas: 0, temNumero: false })).toEqual(["sem_numero"]);
  });

  it("sem número E muitas leituras sem conversa: os dois avisos, o do número primeiro", () => {
    expect(avisosDoQr({ leituras: 50, conversas: 0, temNumero: false })).toEqual([
      "sem_numero",
      "leituras_sem_conversa",
    ]);
  });
});
