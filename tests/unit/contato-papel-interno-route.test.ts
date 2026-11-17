// @vitest-environment node
/**
 * PUT /api/v1/contacts/:id/papel-interno — quem pode definir o papel de um contato da equipe e o que acontece.
 *
 * O papel dá à secretaria e ao marketing um canal com a IA (agenda, campanhas). Por isso: só gerente ou admin; o
 * contato vai junto para "fora do funil" (o banco exige); quem pediu para não receber mensagens, quem foi anonimizado
 * e quem não tem número nunca recebe papel.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  contato: null as Record<string, unknown> | null,
  erroDoUpdate: null as { code: string; message: string } | null,
  updates: [] as Array<Record<string, unknown>>,
  marcador: vi.fn(async () => ({ alterados: [CONTATO], previa: {} })),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/contatos/fora-do-funil", () => ({ aplicarMarcador: h.marcador }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: h.contato, error: null });
      q.update = (patch: Record<string, unknown>) => {
        h.updates.push(patch);
        return { eq: () => ({ eq: async () => ({ error: h.erroDoUpdate }) }) };
      };
      return q;
    },
  }),
}));

const usuario: AuthUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "gerente@clinica.com.br",
  full_name: "Gerente",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "manager" }],
};
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "manager" };

const contexto = (id = CONTATO) => ({ params: Promise.resolve({ id }) });
const pedido = (corpo: unknown) =>
  new NextRequest(`https://crm.exemplo/api/v1/contacts/${CONTATO}/papel-interno`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });

const contatoComum = {
  id: CONTATO,
  phone_number: "5548999990000",
  wa_lid: null,
  is_blocked: false,
  is_anonymized: false,
  fora_do_funil_em: null,
  papel_interno: null,
};

async function rota() {
  return import("@/app/api/v1/contacts/[id]/papel-interno/route");
}

beforeEach(() => {
  vi.mocked(requireRole).mockReset();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva } as never);
  h.contato = { ...contatoComum };
  h.erroDoUpdate = null;
  h.updates.length = 0;
  h.marcador.mockClear();
  h.audit.mockClear();
});

describe("PUT papel-interno — autorização e validação", () => {
  it("exige gerente (um atendente não define o papel de ninguém)", async () => {
    const { PUT } = await rota();
    await PUT(pedido({ papel: "secretaria" }), contexto());
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contact_role" }));
  });

  it("devolve a recusa do requireRole sem tocar em nada", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "sem permissão", 403, {}),
    } as never);
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: "secretaria" }), contexto());
    expect(r.status).toBe(403);
    expect(h.updates).toHaveLength(0);
    expect(h.marcador).not.toHaveBeenCalled();
  });

  it("id que não é uuid: 400", async () => {
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: "secretaria" }), contexto("nao-e-uuid"));
    expect(r.status).toBe(400);
  });

  it("papel desconhecido ('admin', 'dono', texto livre): 422, nada é gravado", async () => {
    const { PUT } = await rota();
    for (const papel of ["admin", "dono", "Secretaria", "", 7]) {
      const r = await PUT(pedido({ papel }), contexto());
      expect(r.status).toBe(422);
    }
    expect(h.updates).toHaveLength(0);
  });

  it("corpo ausente: 422", async () => {
    const { PUT } = await rota();
    const r = await PUT(
      new NextRequest(`https://crm.exemplo/api/v1/contacts/${CONTATO}/papel-interno`, { method: "PUT" }),
      contexto(),
    );
    expect(r.status).toBe(422);
  });

  it("contato inexistente (ou de outra organização, que a RLS esconde): 404", async () => {
    h.contato = null;
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: "secretaria" }), contexto());
    expect(r.status).toBe(404);
    expect(h.updates).toHaveLength(0);
  });
});

describe("PUT papel-interno — quem NÃO pode receber papel", () => {
  it.each([
    ["bloqueado (pediu para não receber mensagens)", { is_blocked: true }],
    ["anonimizado", { is_anonymized: true }],
    ["sem número de WhatsApp", { phone_number: null, wa_lid: null }],
  ])("contato %s: 422 e nada é gravado", async (_nome, mudanca) => {
    h.contato = { ...contatoComum, ...mudanca };
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: "marketing" }), contexto());
    expect(r.status).toBe(422);
    expect(h.updates).toHaveLength(0);
    expect(h.marcador).not.toHaveBeenCalled();
  });

  it("tirar o papel de um contato bloqueado é permitido (não depende de ele poder receber)", async () => {
    h.contato = { ...contatoComum, is_blocked: true, papel_interno: "secretaria", fora_do_funil_em: "2026-11-01T00:00:00Z" };
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: null }), contexto());
    expect(r.status).toBe(200);
    expect(h.updates).toEqual([{ papel_interno: null }]);
  });
});

describe("PUT papel-interno — o que acontece ao definir", () => {
  it("contato do funil: marca fora do funil ANTES de gravar o papel, e audita", async () => {
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: "secretaria" }), contexto());
    expect(r.status).toBe(200);
    expect(h.marcador).toHaveBeenCalledTimes(1);
    expect(h.marcador).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, contactIds: [CONTATO], marcar: true }),
    );
    expect(h.updates).toEqual([{ papel_interno: "secretaria" }]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.papel_interno_alterado",
        organizationId: ORG,
        resourceId: CONTATO,
        metadata: { de: null, para: "secretaria", marcou_fora_do_funil: true },
      }),
    );
    const corpo = (await r.json()) as { data: { papel: string; alterado: boolean; fora_do_funil: boolean } };
    expect(corpo.data).toMatchObject({ papel: "secretaria", alterado: true, fora_do_funil: true });
  });

  it("contato que já estava fora do funil: não marca de novo", async () => {
    h.contato = { ...contatoComum, fora_do_funil_em: "2026-11-01T00:00:00Z" };
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: "marketing" }), contexto());
    expect(r.status).toBe(200);
    expect(h.marcador).not.toHaveBeenCalled();
    expect(h.updates).toEqual([{ papel_interno: "marketing" }]);
  });

  it("trocar de secretaria para marketing: grava e audita de→para", async () => {
    h.contato = { ...contatoComum, fora_do_funil_em: "2026-11-01T00:00:00Z", papel_interno: "secretaria" };
    const { PUT } = await rota();
    await PUT(pedido({ papel: "marketing" }), contexto());
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { de: "secretaria", para: "marketing", marcou_fora_do_funil: false } }),
    );
  });

  it("o mesmo papel de novo: 200, alterado=false, nada gravado e nada auditado", async () => {
    h.contato = { ...contatoComum, fora_do_funil_em: "2026-11-01T00:00:00Z", papel_interno: "secretaria" };
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: "secretaria" }), contexto());
    const corpo = (await r.json()) as { data: { alterado: boolean } };
    expect(corpo.data.alterado).toBe(false);
    expect(h.updates).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("tirar o papel: grava nulo e NÃO devolve o contato ao funil", async () => {
    h.contato = { ...contatoComum, fora_do_funil_em: "2026-11-01T00:00:00Z", papel_interno: "secretaria" };
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: null }), contexto());
    expect(r.status).toBe(200);
    expect(h.updates).toEqual([{ papel_interno: null }]);
    expect(h.marcador).not.toHaveBeenCalled();
    const corpo = (await r.json()) as { data: { fora_do_funil: boolean } };
    expect(corpo.data.fora_do_funil).toBe(true);
  });
});

describe("PUT papel-interno — o gatilho do banco", () => {
  it("recusa do gatilho (42501: não é gerente/admin) vira 403, nunca 500", async () => {
    h.erroDoUpdate = { code: "42501", message: "papel_interno: só gerente ou admin define o papel de um contato" };
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: "secretaria" }), contexto());
    expect(r.status).toBe(403);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("outro erro do banco: 500, sem auditar uma mudança que não aconteceu", async () => {
    h.erroDoUpdate = { code: "XX000", message: "falha" };
    const { PUT } = await rota();
    const r = await PUT(pedido({ papel: "secretaria" }), contexto());
    expect(r.status).toBe(500);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
