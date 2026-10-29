import { describe, expect, it } from "vitest";

import { criarQrCodeSchema, editarQrCodeSchema } from "./qr-codes";

const CANAL = "6f0d1c1e-3b7a-4c58-9d1e-2a4b5c6d7e8f";

describe("criarQrCodeSchema", () => {
  it("apara o nome e junta espaços repetidos", () => {
    const r = criarQrCodeSchema.parse({ nome: "  Cartaz   da recepção ", mensagem: "Olá!", channel_session_id: CANAL });
    expect(r.nome).toBe("Cartaz da recepção");
  });

  it("recusa nome vazio ou só espaço", () => {
    expect(criarQrCodeSchema.safeParse({ nome: "", mensagem: "Olá", channel_session_id: CANAL }).success).toBe(false);
    expect(criarQrCodeSchema.safeParse({ nome: "   ", mensagem: "Olá", channel_session_id: CANAL }).success).toBe(false);
  });

  it("recusa nome de 81 caracteres e mensagem de 301", () => {
    expect(criarQrCodeSchema.safeParse({ nome: "a".repeat(81), mensagem: "Olá", channel_session_id: CANAL }).success).toBe(false);
    expect(criarQrCodeSchema.safeParse({ nome: "ok", mensagem: "a".repeat(301), channel_session_id: CANAL }).success).toBe(false);
    expect(criarQrCodeSchema.safeParse({ nome: "a".repeat(80), mensagem: "a".repeat(300), channel_session_id: CANAL }).success).toBe(true);
  });

  it("recusa channel_session_id que não é uuid", () => {
    expect(criarQrCodeSchema.safeParse({ nome: "ok", mensagem: "Olá", channel_session_id: "abc" }).success).toBe(false);
  });
});

describe("editarQrCodeSchema", () => {
  it("recusa corpo vazio — editar sem mudar nada é erro de quem chama", () => {
    expect(editarQrCodeSchema.safeParse({}).success).toBe(false);
  });

  it("aceita só arquivar", () => {
    expect(editarQrCodeSchema.safeParse({ arquivado: true }).success).toBe(true);
    expect(editarQrCodeSchema.safeParse({ arquivado: false }).success).toBe(true);
  });

  it("aceita só renomear, e o nome continua validado", () => {
    expect(editarQrCodeSchema.safeParse({ nome: "Novo nome" }).success).toBe(true);
    expect(editarQrCodeSchema.safeParse({ nome: "  " }).success).toBe(false);
  });
});
