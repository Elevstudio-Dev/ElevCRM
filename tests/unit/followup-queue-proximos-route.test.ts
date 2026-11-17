/**
 * GET /api/v1/ai/followups/queue/proximos — o que a rota promete.
 *
 * O ponto que importa: a varredura lê com service-role, que enxerga TODAS as
 * organizações. A rota tem de devolver só os fluxos da organização do usuário, e
 * só os que têm ritmo — senão um viewer vê a fila de outra clínica.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseSilenceSweepDb, proximosDaFila } from "@/lib/followup/silence-sweep";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/followup/silence-sweep", () => ({
  createSupabaseSilenceSweepDb: vi.fn(),
  proximosDaFila: vi.fn(),
}));

import { GET } from "@/app/api/v1/ai/followups/queue/proximos/route";

const MINHA = "22222222-2222-4222-8222-222222222222";
const OUTRA = "99999999-9999-4999-8999-999999999999";
const RITMO = { min_minutos: 3, max_minutos: 9, limite_por_dia: 25 };

function pointer(id: string, org: string, ritmo: typeof RITMO | null) {
  return {
    id,
    organization_id: org,
    active_version_id: "v",
    threshold_minutes: 60,
    segments: [],
    ritmo,
  };
}

function clienteDoUsuario() {
  const consulta = (linhas: unknown[]) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.in = () => Promise.resolve({ data: linhas, error: null });
    return q;
  };
  return {
    from: (tabela: string) =>
      tabela === "followup_flow_pointers"
        ? consulta([{ id: "p-minha", name: "Reativação" }])
        : consulta([{ id: "c-1", name: "Glória", display_name: null, phone_number: null }]),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u", email: "u@example.com" } as unknown as AuthUser,
    org: { orgId: MINHA, name: "Clínica", role: "viewer" },
  });
  vi.mocked(createAdminClient).mockReturnValue({} as never);
  vi.mocked(createClient).mockResolvedValue(clienteDoUsuario() as never);
});

describe("GET /queue/proximos", () => {
  it("só devolve fluxos da minha organização e só os com ritmo", async () => {
    vi.mocked(createSupabaseSilenceSweepDb).mockReturnValue({
      loadActiveSilencePointers: async () => [
        pointer("p-minha", MINHA, RITMO),
        pointer("p-sem-ritmo", MINHA, null),
        pointer("p-outra-org", OUTRA, RITMO),
      ],
      loadInscricoesRecentes: async () => ({ criadasEm: [new Date()], ultima: null }),
    } as never);
    vi.mocked(proximosDaFila).mockResolvedValue([
      { contactId: "c-1", posicao: 1, entraEm: new Date("2026-11-18T15:00:00.000Z") },
    ]);

    const res = await GET(new NextRequest("http://localhost/api/v1/ai/followups/queue/proximos"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { fluxos: Array<{ pointer_id: string; usados_24h: number; itens: Array<{ contact: { name: string } }> }> };
    };

    expect(vi.mocked(proximosDaFila)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(proximosDaFila).mock.calls[0]![1].id).toBe("p-minha");
    expect(body.data.fluxos).toHaveLength(1);
    expect(body.data.fluxos[0]!.pointer_id).toBe("p-minha");
    expect(body.data.fluxos[0]!.usados_24h).toBe(1);
    expect(body.data.fluxos[0]!.itens[0]!.contact.name).toBe("Glória");
  });

  it("sem fluxo com ritmo, devolve lista vazia sem consultar a fila", async () => {
    vi.mocked(createSupabaseSilenceSweepDb).mockReturnValue({
      loadActiveSilencePointers: async () => [pointer("p-sem-ritmo", MINHA, null)],
    } as never);
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/followups/queue/proximos"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { fluxos: unknown[] } }).data.fluxos).toEqual([]);
    expect(vi.mocked(proximosDaFila)).not.toHaveBeenCalled();
  });

  it("sem permissão, devolve a resposta do gate", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/followups/queue/proximos"));
    expect(res.status).toBe(403);
  });
});
