// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "6f0d1c1e-3b7a-4c58-9d1e-2a4b5c6d7e8f";

type Resp = { data: unknown; error: { code?: string; message: string } | null };
let papelMinimo: string | null = null;
let negado = false;
let listaResp: Resp;
let insertResp: Resp;
let updateResp: Resp;
const inserts: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
const filtros: Array<[string, unknown]> = [];
const isNulls: string[] = [];
const audit = vi.fn(async (_entrada: unknown) => {});

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async (min: string) => {
    papelMinimo = min;
    return negado
      ? { ok: false, response: new Response(null, { status: 403 }) }
      : { ok: true, user: { id: "u-1" }, org: { orgId: "org-1" } };
  },
}));
vi.mock("@/lib/audit", () => ({ audit: (entrada: unknown) => audit(entrada) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from() {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return b;
        },
        is: (c: string) => {
          isNulls.push(c);
          return b;
        },
        order: () => b,
        limit: () => b,
        insert: (l: Record<string, unknown>) => {
          inserts.push(l);
          return b;
        },
        update: (l: Record<string, unknown>) => {
          updates.push(l);
          return b;
        },
        single: async () => insertResp,
        maybeSingle: async () => updateResp,
        then: (r: (v: unknown) => void) => Promise.resolve(listaResp).then(r),
      });
      return b;
    },
  }),
}));

import { GET, POST } from "./route";
import { PATCH } from "./[id]/route";

const req = (metodo: string, corpo?: unknown, url = "http://localhost/api/v1/tipos-fora-do-funil") =>
  new Request(url, { method: metodo, ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }) }) as never;
const tipo = (extra: Record<string, unknown> = {}) => ({ id: ID, nome: "Equipe", arquivado_em: null, created_at: "2026-10-29T12:00:00Z", ...extra });

beforeEach(() => {
  papelMinimo = null;
  negado = false;
  listaResp = { data: [tipo()], error: null };
  insertResp = { data: tipo(), error: null };
  updateResp = { data: tipo(), error: null };
  inserts.length = 0;
  updates.length = 0;
  filtros.length = 0;
  isNulls.length = 0;
  audit.mockClear();
});

describe("GET /api/v1/tipos-fora-do-funil", () => {
  it("qualquer atendente lê (o diálogo de marcar precisa da lista), só da organização ativa", async () => {
    const r = await GET(req("GET"));
    expect(r.status).toBe(200);
    expect(papelMinimo).toBe("agent");
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect((await r.json()).data).toHaveLength(1);
  });

  it("por padrão esconde os arquivados; com ?arquivados=1 os traz", async () => {
    await GET(req("GET"));
    expect(isNulls).toContain("arquivado_em");
    isNulls.length = 0;
    await GET(req("GET", undefined, "http://localhost/api/v1/tipos-fora-do-funil?arquivados=1"));
    expect(isNulls).not.toContain("arquivado_em");
  });

  it("sem papel: 403", async () => {
    negado = true;
    expect((await GET(req("GET"))).status).toBe(403);
  });
});

describe("POST /api/v1/tipos-fora-do-funil", () => {
  it("criar exige GESTOR (atendente lê, não cadastra)", async () => {
    await POST(req("POST", { nome: "Contador" }));
    expect(papelMinimo).toBe("manager");
  });

  it("cria com a organização da sessão e audita", async () => {
    const r = await POST(req("POST", { nome: "  Dentista   parceiro ", organization_id: "org-de-outro" }));
    expect(r.status).toBe(201);
    expect(inserts[0]).toMatchObject({ organization_id: "org-1", nome: "Dentista parceiro", created_by_user_id: "u-1" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "tipo_fora_do_funil.criado", resourceId: ID }));
  });

  it("nome vazio ou de 41 letras: 422", async () => {
    expect((await POST(req("POST", { nome: "   " }))).status).toBe(422);
    expect((await POST(req("POST", { nome: "a".repeat(41) }))).status).toBe(422);
    expect(inserts).toHaveLength(0);
  });

  it("nome repetido (índice único): 422 com mensagem clara", async () => {
    insertResp = { data: null, error: { code: "23505", message: "duplicate" } };
    const r = await POST(req("POST", { nome: "Equipe" }));
    expect(r.status).toBe(422);
    expect((await r.json()).error.message).toMatch(/já existe/i);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem papel de gestor: 403", async () => {
    negado = true;
    expect((await POST(req("POST", { nome: "x" }))).status).toBe(403);
    expect(inserts).toHaveLength(0);
  });
});

describe("PATCH /api/v1/tipos-fora-do-funil/[id]", () => {
  const patch = (corpo: unknown) => PATCH(req("PATCH", corpo), { params: Promise.resolve({ id: ID }) });

  it("renomear audita 'renomeado'; arquivar, 'arquivado'; reativar, 'reativado'", async () => {
    await patch({ nome: "Contabilidade" });
    await patch({ arquivado: true });
    await patch({ arquivado: false });
    expect(audit.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual([
      "tipo_fora_do_funil.renomeado",
      "tipo_fora_do_funil.arquivado",
      "tipo_fora_do_funil.reativado",
    ]);
    expect(typeof updates[1]!.arquivado_em).toBe("string");
    expect(updates[2]!.arquivado_em).toBeNull();
  });

  it("filtra por organização E id; tipo de outra organização não é achado: 404 e sem auditoria", async () => {
    updateResp = { data: null, error: null };
    expect((await patch({ nome: "x" })).status).toBe(404);
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect(filtros).toContainEqual(["id", ID]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("corpo vazio: 422", async () => {
    expect((await patch({})).status).toBe(422);
  });

  it("renomear para um nome já usado: 422", async () => {
    updateResp = { data: null, error: { code: "23505", message: "duplicate" } };
    expect((await patch({ nome: "Equipe" })).status).toBe(422);
  });

  it("sem papel de gestor: 403", async () => {
    negado = true;
    expect((await patch({ nome: "x" })).status).toBe(403);
    expect(updates).toHaveLength(0);
  });
});
