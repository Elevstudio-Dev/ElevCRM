// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { code?: string; message: string } | null };

const CANAL = "6f0d1c1e-3b7a-4c58-9d1e-2a4b5c6d7e8f";
const QR_ID = "0b6f7e0a-2f1d-4f3b-8a55-4a3c1d9e7b21";

let papelOk = true;
let canalResp: Resp;
let updateResp: Resp;
let insertResp: Resp[];
let listaQr: Resp;
let listaCanais: Resp;
const inserts: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
const audit = vi.fn(async () => {});

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    papelOk
      ? { ok: true, user: { id: "u-1" }, org: { orgId: "org-1" } }
      : { ok: false, response: new Response(null, { status: 403 }) },
}));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(tabela: string) {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (coluna: string, valor: unknown) => {
          filtros.push({ tabela, coluna, valor });
          return b;
        },
        order: () => b,
        limit: () => b,
        insert: (linha: Record<string, unknown>) => {
          inserts.push(linha);
          return b;
        },
        update: (linha: Record<string, unknown>) => {
          updates.push(linha);
          return b;
        },
        maybeSingle: async () => (tabela === "channel_sessions" ? canalResp : updateResp),
        single: async () => insertResp.shift() ?? { data: null, error: { message: "sem resposta" } },
        then: (r: (v: unknown) => void) => Promise.resolve(tabela === "qr_codes" ? listaQr : listaCanais).then(r),
      });
      return b;
    },
  }),
}));

import { GET, POST } from "./route";
import { PATCH } from "./[id]/route";

const linhaDoQr = (extra: Record<string, unknown> = {}) => ({
  id: QR_ID,
  codigo: "R7K2QH",
  nome: "Cartaz",
  mensagem: "Olá!",
  channel_session_id: CANAL,
  arquivado_em: null,
  created_at: "2026-10-29T12:00:00Z",
  updated_at: "2026-10-29T12:00:00Z",
  ...extra,
});

const post = (corpo: unknown) =>
  POST(new Request("http://localhost/api/v1/qr-codes", { method: "POST", body: JSON.stringify(corpo) }) as never);
const patch = (corpo: unknown, id = QR_ID) =>
  PATCH(new Request(`http://localhost/api/v1/qr-codes/${id}`, { method: "PATCH", body: JSON.stringify(corpo) }) as never, {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  papelOk = true;
  canalResp = { data: { id: CANAL, phone_number: "+5511987654321" }, error: null };
  updateResp = { data: linhaDoQr(), error: null };
  insertResp = [{ data: linhaDoQr(), error: null }];
  listaQr = { data: [linhaDoQr()], error: null };
  listaCanais = {
    data: [{ id: CANAL, display_name: "Recepção", phone_number: "+5511987654321", status: "WORKING" }],
    error: null,
  };
  inserts.length = 0;
  updates.length = 0;
  filtros.length = 0;
  audit.mockClear();
});

describe("GET /api/v1/qr-codes", () => {
  it("sem papel de gestor: 403 e nada é lido", async () => {
    papelOk = false;
    expect((await GET()).status).toBe(403);
  });

  it("devolve os QR codes e os canais com telefone/estado", async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    const corpo = await r.json();
    expect(corpo.data.qr_codes).toHaveLength(1);
    expect(corpo.data.canais).toEqual([{ id: CANAL, nome: "Recepção", telefone: "+5511987654321", conectado: true }]);
  });

  it("lê SÓ a organização ativa", async () => {
    await GET();
    expect(filtros).toContainEqual({ tabela: "qr_codes", coluna: "organization_id", valor: "org-1" });
    expect(filtros).toContainEqual({ tabela: "channel_sessions", coluna: "organization_id", valor: "org-1" });
  });
});

describe("POST /api/v1/qr-codes", () => {
  const corpo = { nome: "Cartaz", mensagem: "Olá!", channel_session_id: CANAL };

  it("sem papel de gestor: 403", async () => {
    papelOk = false;
    expect((await post(corpo)).status).toBe(403);
    expect(inserts).toHaveLength(0);
  });

  it("canal sem telefone conectado: 422 e nada é criado", async () => {
    canalResp = { data: { id: CANAL, phone_number: null }, error: null };
    expect((await post(corpo)).status).toBe(422);
    expect(inserts).toHaveLength(0);
  });

  it("canal de outra organização (não achado): 422", async () => {
    canalResp = { data: null, error: null };
    expect((await post(corpo)).status).toBe(422);
    expect(inserts).toHaveLength(0);
  });

  it("corpo inválido: 422", async () => {
    expect((await post({ nome: "", mensagem: "x", channel_session_id: CANAL })).status).toBe(422);
  });

  it("cria com código sorteado, organização da sessão e auditoria", async () => {
    const r = await post(corpo);
    expect(r.status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ organization_id: "org-1", nome: "Cartaz", created_by_user_id: "u-1" });
    expect(inserts[0]!.codigo).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "qr_code.created", organizationId: "org-1", resourceId: QR_ID }),
    );
  });

  it("o organization_id vem da sessão, NUNCA do corpo", async () => {
    await post({ ...corpo, organization_id: "org-de-outro" });
    expect(inserts[0]!.organization_id).toBe("org-1");
  });

  it("colisão do código (23505) sorteia de novo e cria", async () => {
    insertResp = [
      { data: null, error: { code: "23505", message: "duplicate" } },
      { data: linhaDoQr(), error: null },
    ];
    const r = await post(corpo);
    expect(r.status).toBe(201);
    expect(inserts).toHaveLength(2);
  });
});

describe("PATCH /api/v1/qr-codes/[id]", () => {
  it("arquivar grava arquivado_em e audita qr_code.archived", async () => {
    updateResp = { data: linhaDoQr({ arquivado_em: "2026-10-29T13:00:00Z" }), error: null };
    const r = await patch({ arquivado: true });
    expect(r.status).toBe(200);
    expect(typeof updates[0]!.arquivado_em).toBe("string");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "qr_code.archived", resourceId: QR_ID }));
  });

  it("reativar zera arquivado_em e audita qr_code.restored", async () => {
    await patch({ arquivado: false });
    expect(updates[0]!.arquivado_em).toBeNull();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "qr_code.restored" }));
  });

  it("renomear audita qr_code.updated e NÃO mexe no código", async () => {
    await patch({ nome: "Outro nome" });
    expect(updates[0]).toEqual({ nome: "Outro nome" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "qr_code.updated" }));
  });

  it("filtra por organização E id — QR de outra org não é achado: 404", async () => {
    updateResp = { data: null, error: null };
    expect((await patch({ nome: "x" })).status).toBe(404);
    expect(filtros).toContainEqual({ tabela: "qr_codes", coluna: "organization_id", valor: "org-1" });
    expect(filtros).toContainEqual({ tabela: "qr_codes", coluna: "id", valor: QR_ID });
    expect(audit).not.toHaveBeenCalled();
  });

  it("trocar para canal sem telefone: 422", async () => {
    canalResp = { data: { id: CANAL, phone_number: null }, error: null };
    expect((await patch({ channel_session_id: CANAL })).status).toBe(422);
    expect(updates).toHaveLength(0);
  });

  it("sem papel de gestor: 403", async () => {
    papelOk = false;
    expect((await patch({ nome: "x" })).status).toBe(403);
    expect(updates).toHaveLength(0);
  });
});
