// @vitest-environment node
/**
 * POST /api/v1/contacts/fora-do-funil — quem tem papel (secretaria, marketing) não volta ao funil.
 *
 * O banco recusa (CHECK da 0227); a rota diz o porquê em português ANTES, em vez de deixar o erro virar um 500.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  comPapel: [] as Array<{ id: string }>,
  marcador: vi.fn(async () => ({ alterados: ["33333333-3333-4333-8333-333333333333"], previa: { negocios: {} } })),
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
      for (const m of ["select", "eq", "in", "not"]) q[m] = () => q;
      q.limit = async () => ({ data: h.comPapel, error: null });
      return q;
    },
  }),
}));

const usuario: AuthUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@clinica.com.br",
  full_name: "Ana",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "agent" }],
};
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "agent" };

const pedido = (corpo: unknown) =>
  new NextRequest("https://crm.exemplo/api/v1/contacts/fora-do-funil", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });

beforeEach(() => {
  vi.mocked(requireRole).mockReset();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva } as never);
  h.comPapel = [];
  h.marcador.mockClear();
});

describe("POST fora-do-funil e o papel de contato", () => {
  it("devolver ao funil quem tem papel: 422 com a razão, e nada é alterado", async () => {
    h.comPapel = [{ id: CONTATO }];
    const { POST } = await import("@/app/api/v1/contacts/fora-do-funil/route");
    const r = await POST(pedido({ contact_ids: [CONTATO], marcar: false }));
    expect(r.status).toBe(422);
    const corpo = (await r.json()) as { error: { message: string } };
    expect(corpo.error.message).toMatch(/papel/i);
    expect(h.marcador).not.toHaveBeenCalled();
  });

  it("devolver ao funil quem NÃO tem papel segue o caminho de sempre", async () => {
    const { POST } = await import("@/app/api/v1/contacts/fora-do-funil/route");
    const r = await POST(pedido({ contact_ids: [CONTATO], marcar: false }));
    expect(r.status).toBe(200);
    expect(h.marcador).toHaveBeenCalledTimes(1);
  });

  it("marcar como fora do funil não consulta papel nenhum (só o caminho de volta é restrito)", async () => {
    h.comPapel = [{ id: CONTATO }];
    const { POST } = await import("@/app/api/v1/contacts/fora-do-funil/route");
    const r = await POST(pedido({ contact_ids: [CONTATO], marcar: true }));
    expect(r.status).toBe(200);
    expect(h.marcador).toHaveBeenCalledTimes(1);
  });
});
