// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "6f0d1c1e-3b7a-4c58-9d1e-2a4b5c6d7e8f";
const B = "0b6f7e0a-2f1d-4f3b-8a55-4a3c1d9e7b21";
const TIPO = "9a3f1c1e-3b7a-4c58-9d1e-2a4b5c6d7e00";

let papel: "ok" | "negado" = "ok";
let tipoExiste = true;
let alterados: string[] = [A];
const aplicar = vi.fn();
const previa = vi.fn();
const audit = vi.fn(async () => {});
const filtrosDoTipo: Array<[string, unknown]> = [];

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async (min: string) =>
    papel === "ok"
      ? { ok: true, user: { id: "u-1" }, org: { orgId: "org-1" }, min }
      : { ok: false, response: new Response(null, { status: 403 }) },
}));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/contatos/fora-do-funil", () => ({
  aplicarMarcador: (...a: unknown[]) => aplicar(...a),
  previaDoMarcador: (...a: unknown[]) => previa(...a),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from() {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (c: string, v: unknown) => {
          filtrosDoTipo.push([c, v]);
          return b;
        },
        is: () => b,
        maybeSingle: async () => ({ data: tipoExiste ? { id: TIPO } : null, error: null }),
      });
      return b;
    },
  }),
}));

import { POST } from "./route";
import { POST as POST_PREVIA } from "./previa/route";

const pedir = (rota: typeof POST, corpo: unknown) =>
  rota(new Request("http://localhost/api/v1/contacts/fora-do-funil", { method: "POST", body: JSON.stringify(corpo) }) as never);

const PREVIA = { contatos: 1, negocios: { abertos: 2, ganhos: 1, perdidos: 0, valor_ganho_cents: 150000 }, aproximado: false };

beforeEach(() => {
  papel = "ok";
  tipoExiste = true;
  alterados = [A];
  filtrosDoTipo.length = 0;
  aplicar.mockReset();
  aplicar.mockImplementation(async () => ({ alterados, previa: PREVIA }));
  previa.mockReset();
  previa.mockResolvedValue(PREVIA);
  audit.mockClear();
});

describe("POST /api/v1/contacts/fora-do-funil", () => {
  it("sem papel de atendente: 403 e nada acontece", async () => {
    papel = "negado";
    expect((await pedir(POST, { contact_ids: [A], marcar: true })).status).toBe(403);
    expect(aplicar).not.toHaveBeenCalled();
  });

  it("corpo inválido: 422 (lista vazia, id que não é uuid, mais de 200, falta o marcar)", async () => {
    expect((await pedir(POST, { contact_ids: [], marcar: true })).status).toBe(422);
    expect((await pedir(POST, { contact_ids: ["x"], marcar: true })).status).toBe(422);
    expect((await pedir(POST, { contact_ids: [A] })).status).toBe(422);
    const muitos = Array.from({ length: 201 }, (_, i) => `6f0d1c1e-3b7a-4c58-9d1e-${String(i).padStart(12, "0")}`);
    expect((await pedir(POST, { contact_ids: muitos, marcar: true })).status).toBe(422);
    expect(aplicar).not.toHaveBeenCalled();
  });

  it("marca, devolve o que saiu, e audita com autor e o que foi escondido", async () => {
    const r = await pedir(POST, { contact_ids: [A], marcar: true, tipo_id: TIPO });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ alterados: 1, previa: PREVIA });
    expect(aplicar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org-1", userId: "u-1", contactIds: [A], marcar: true, tipoId: TIPO }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.fora_do_funil_marcado",
        organizationId: "org-1",
        actorUserId: "u-1",
        resourceId: A,
        metadata: expect.objectContaining({ contatos: 1, tipo_id: TIPO, negocios: PREVIA.negocios }),
      }),
    );
  });

  it("o organization_id vem da SESSÃO, nunca do corpo", async () => {
    await pedir(POST, { contact_ids: [A], marcar: true, organization_id: "org-de-outro" });
    expect(aplicar.mock.calls[0]![1]).toMatchObject({ organizationId: "org-1" });
  });

  it("desmarcar audita 'desmarcado' e não carrega tipo", async () => {
    await pedir(POST, { contact_ids: [A], marcar: false, tipo_id: TIPO });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.fora_do_funil_desmarcado", metadata: expect.objectContaining({ tipo_id: null }) }),
    );
    expect(aplicar.mock.calls[0]![1]).not.toHaveProperty("tipoId");
  });

  it("em lote, o recurso da auditoria fica nulo e os ids vão no metadata", async () => {
    alterados = [A, B];
    await pedir(POST, { contact_ids: [A, B], marcar: true });
    const entrada = audit.mock.calls[0]![0] as Record<string, unknown>;
    expect(entrada.resourceId).toBeNull();
    expect(entrada.metadata).toMatchObject({ contatos: 2, contact_ids: [A, B] });
  });

  it("ninguém mudou de estado (já estavam marcados): não suja a auditoria", async () => {
    alterados = [];
    expect((await pedir(POST, { contact_ids: [A], marcar: true })).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("tipo que não é da organização (ou foi arquivado): 422 e nada é marcado", async () => {
    tipoExiste = false;
    expect((await pedir(POST, { contact_ids: [A], marcar: true, tipo_id: TIPO })).status).toBe(422);
    expect(aplicar).not.toHaveBeenCalled();
    expect(filtrosDoTipo).toContainEqual(["organization_id", "org-1"]);
  });

  it("repetir o mesmo contato na seleção conta uma vez", async () => {
    await pedir(POST, { contact_ids: [A, A, A], marcar: true });
    expect(aplicar.mock.calls[0]![1]).toMatchObject({ contactIds: [A] });
  });

  it("falha do banco vira 500 com a mensagem, não sucesso mudo", async () => {
    aplicar.mockRejectedValue(new Error("boom"));
    expect((await pedir(POST, { contact_ids: [A], marcar: true })).status).toBe(500);
  });
});

describe("POST /api/v1/contacts/fora-do-funil/previa", () => {
  it("sem papel de atendente: 403", async () => {
    papel = "negado";
    expect((await pedir(POST_PREVIA, { contact_ids: [A], marcar: true })).status).toBe(403);
  });

  it("devolve o que mudaria e NÃO audita nem muda nada", async () => {
    const r = await pedir(POST_PREVIA, { contact_ids: [A], marcar: true });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual(PREVIA);
    expect(previa).toHaveBeenCalledWith(expect.anything(), "org-1", [A], true);
    expect(aplicar).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("corpo inválido: 422", async () => {
    expect((await pedir(POST_PREVIA, { contact_ids: [], marcar: true })).status).toBe(422);
  });
});
