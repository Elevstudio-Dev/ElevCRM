import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { origemDoQr, reconhecerQrCodeNaEntrada, vincularLeadAoQr } from "./reconhecer";

let conversa: { is_group: boolean } | null;
let qr: { id: string; nome: string; codigo: string } | null;
let erroDoInsert: { code?: string; message: string } | null;
const inserts: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
const updates: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
let leituras = 0;

const admin = {
  from(tabela: string) {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (coluna: string, valor: unknown) => {
        filtros.push({ tabela, coluna, valor });
        return b;
      },
      maybeSingle: async () => {
        leituras++;
        return { data: tabela === "conversations" ? conversa : qr, error: null };
      },
      insert: async (linha: Record<string, unknown>) => {
        inserts.push({ tabela, linha });
        return { error: erroDoInsert };
      },
      update: (linha: Record<string, unknown>) => {
        updates.push({ tabela, linha });
        return b;
      },
      then: (r: (v: unknown) => void) => Promise.resolve({ error: null }).then(r),
    });
    return b;
  },
} as never;

const ENTRADA = {
  organizationId: "org-1",
  conversationId: "conv-1",
  contactId: "ct-1",
  messageId: "msg-1",
  texto: "Olá! Vi o cartaz #R7K2QH",
};

beforeEach(() => {
  conversa = { is_group: false };
  qr = { id: "qr-1", nome: "Cartaz da recepção", codigo: "R7K2QH" };
  erroDoInsert = null;
  inserts.length = 0;
  updates.length = 0;
  filtros.length = 0;
  leituras = 0;
});

describe("reconhecerQrCodeNaEntrada", () => {
  it("mensagem SEM código não toca o banco", async () => {
    expect(await reconhecerQrCodeNaEntrada(admin, { ...ENTRADA, texto: "oi, tudo bem?" })).toBeNull();
    expect(leituras).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("código da org: grava a conversa e devolve o QR", async () => {
    expect(await reconhecerQrCodeNaEntrada(admin, ENTRADA)).toEqual(qr);
    expect(inserts).toEqual([
      {
        tabela: "qr_code_conversas",
        linha: {
          organization_id: "org-1",
          qr_code_id: "qr-1",
          conversation_id: "conv-1",
          contact_id: "ct-1",
          message_id: "msg-1",
        },
      },
    ]);
  });

  it("busca o QR SÓ na organização da mensagem — código de outra org não casa", async () => {
    await reconhecerQrCodeNaEntrada(admin, ENTRADA);
    expect(filtros).toContainEqual({ tabela: "qr_codes", coluna: "organization_id", valor: "org-1" });
    expect(filtros).toContainEqual({ tabela: "qr_codes", coluna: "codigo", valor: "R7K2QH" });
  });

  it("conversa já contada (23505) ainda devolve o QR — o lead novo precisa da origem", async () => {
    erroDoInsert = { code: "23505", message: "duplicate" };
    expect(await reconhecerQrCodeNaEntrada(admin, ENTRADA)).toEqual(qr);
  });

  it("grupo não conta", async () => {
    conversa = { is_group: true };
    expect(await reconhecerQrCodeNaEntrada(admin, ENTRADA)).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("código que não é desta organização é ignorado", async () => {
    qr = null;
    expect(await reconhecerQrCodeNaEntrada(admin, ENTRADA)).toBeNull();
    expect(inserts).toHaveLength(0);
  });
});

describe("origemDoQr e vincularLeadAoQr", () => {
  it("a origem leva id, nome e código, e a tag 'QR code'", () => {
    expect(origemDoQr({ id: "qr-1", nome: "Cartaz", codigo: "R7K2QH" })).toEqual({
      source: "qr_code",
      sourceMetadata: { qr_code_id: "qr-1", qr_code_nome: "Cartaz", qr_code_codigo: "R7K2QH" },
      tags: ["QR code"],
    });
  });

  it("vincular grava o lead_id na conversa do QR", async () => {
    await vincularLeadAoQr(admin, { organizationId: "org-1", conversationId: "conv-1", qrCodeId: "qr-1", leadId: "lead-9" });
    expect(updates).toEqual([{ tabela: "qr_code_conversas", linha: { lead_id: "lead-9" } }]);
  });
});
