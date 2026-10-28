import { describe, expect, it } from "vitest";

import {
  ALFABETO_DO_CODIGO,
  extrairCodigoDaMensagem,
  gerarCodigo,
  mensagemComCodigo,
  normalizarCodigo,
} from "./codigo";

describe("gerarCodigo", () => {
  it("6 caracteres, só do alfabeto sem ambíguos", () => {
    for (let i = 0; i < 200; i++) {
      const c = gerarCodigo();
      expect(c).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    }
  });

  it("descarta bytes que enviesariam o sorteio (>= 248) em vez de usar o resto", () => {
    // 255 seria 255 % 31 = 7 — aceitar daria mais peso aos 8 primeiros símbolos.
    let chamada = 0;
    const fonte = () => {
      chamada++;
      return chamada === 1 ? new Uint8Array([255, 250, 248, 0, 1, 2, 3, 4, 5]) : new Uint8Array(16);
    };
    expect(gerarCodigo(fonte)).toBe(ALFABETO_DO_CODIGO.slice(0, 6));
  });
});

describe("normalizarCodigo", () => {
  it("aceita minúsculas e espaços em volta", () => {
    expect(normalizarCodigo(" r7k2qh ")).toBe("R7K2QH");
  });
  it("recusa ambíguos, tamanho errado e vazio", () => {
    expect(normalizarCodigo("R7K2Q0")).toBeNull(); // 0
    expect(normalizarCodigo("R7K2QI")).toBeNull(); // I
    expect(normalizarCodigo("R7K2Q")).toBeNull();
    expect(normalizarCodigo("R7K2QHH")).toBeNull();
    expect(normalizarCodigo(null)).toBeNull();
  });
});

describe("extrairCodigoDaMensagem", () => {
  it("acha o código no fim da mensagem pronta", () => {
    expect(extrairCodigoDaMensagem("Olá! Vi o cartaz da recepção #R7K2QH")).toBe("R7K2QH");
  });
  it("acha no meio e com pontuação depois", () => {
    expect(extrairCodigoDaMensagem("oi #r7k2qh, tudo bem?")).toBe("R7K2QH");
  });
  it("não acha sem o #, nem dentro de palavra, nem com 7 caracteres", () => {
    expect(extrairCodigoDaMensagem("R7K2QH")).toBeNull();
    expect(extrairCodigoDaMensagem("abc#R7K2QH")).toBeNull();
    expect(extrairCodigoDaMensagem("#R7K2QHX")).toBeNull();
  });
  it("texto vazio ou nulo não é código", () => {
    expect(extrairCodigoDaMensagem(null)).toBeNull();
    expect(extrairCodigoDaMensagem("")).toBeNull();
  });
});

describe("mensagemComCodigo", () => {
  it("frase + espaço + #código, sem espaço duplicado", () => {
    expect(mensagemComCodigo("Olá!  ", "R7K2QH")).toBe("Olá! #R7K2QH");
  });
});
