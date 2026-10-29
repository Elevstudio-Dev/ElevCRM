import { describe, expect, it } from "vitest";

import { digitosDoTelefone, linkDoWhatsApp, linkPublicoDoQr } from "./link-do-whatsapp";

describe("digitosDoTelefone", () => {
  it("tira tudo que não é dígito", () => {
    expect(digitosDoTelefone("+55 (11) 98765-4321")).toBe("5511987654321");
  });
  it("curto ou longo demais não é telefone", () => {
    expect(digitosDoTelefone("12345")).toBeNull();
    expect(digitosDoTelefone("1234567890123456")).toBeNull();
    expect(digitosDoTelefone(null)).toBeNull();
  });
});

describe("linkDoWhatsApp", () => {
  it("wa.me com os dígitos e a mensagem + código codificados", () => {
    expect(linkDoWhatsApp("+5511987654321", "Olá! Vi o cartaz", "R7K2QH")).toBe(
      "https://wa.me/5511987654321?text=Ol%C3%A1!%20Vi%20o%20cartaz%20%23R7K2QH",
    );
  });
  it("sem telefone válido não há link", () => {
    expect(linkDoWhatsApp(null, "x", "R7K2QH")).toBeNull();
  });
});

describe("linkPublicoDoQr", () => {
  it("origem sem barra no fim + /q/código", () => {
    expect(linkPublicoDoQr("https://crm.exemplo.com.br/", "R7K2QH")).toBe("https://crm.exemplo.com.br/q/R7K2QH");
  });
});
