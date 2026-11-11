// @vitest-environment node
/**
 * POST /api/v1/contacts/:id/historico — o que a rota decide ANTES de gravar.
 *
 * A gravação em si está em `importar-historico.test.ts`. Aqui: quem pode, o que acontece quando o canal não sabe
 * (ou não quer) devolver o passado, e que "não consegui falar com o canal" NUNCA vira "0 mensagens".
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { fail } from "@/lib/api/wrappers";
import { HistoricoIndisponivel } from "@/lib/channels/historico";
import type { MensagemDoHistorico } from "@/lib/channels/historico";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const SESSAO = "55555555-5555-4555-8555-555555555555";

const h = vi.hoisted(() => ({
  contato: null as Record<string, unknown> | null,
  conversa: null as Record<string, unknown> | null,
  sessao: null as Record<string, unknown> | null,
  adapter: {} as Record<string, unknown>,
  importar: vi.fn(),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/inbox/importar-historico", () => ({ importarHistoricoDoContato: h.importar }));
vi.mock("@/lib/channels", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels")>()),
  getAdapter: () => h.adapter,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({
        data: tabela === "contacts" ? h.contato : tabela === "conversations" ? h.conversa : h.sessao,
        error: null,
      });
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

const contexto = (id = CONTATO) => ({ params: Promise.resolve({ id }) });
const pedido = () => new NextRequest(`https://crm.exemplo/api/v1/contacts/${CONTATO}/historico`, { method: "POST" });

const mensagem = (id: string): MensagemDoHistorico => ({
  externalId: id,
  idsEquivalentes: [id],
  direcao: "inbound",
  enviadaEm: "2025-03-01T10:00:00.000Z",
  tipo: "text",
  texto: "oi",
  temMidia: false,
  mediaMime: null,
  ack: null,
  nomeDoContato: null,
  anuncio: null,
});

const RESULTADO = {
  encontradas: 2,
  importadas: 2,
  jaExistiam: 0,
  falharam: 0,
  deAnuncio: 1,
  contatoMarcadoComoAnuncio: true,
  primeiraEm: "2025-03-01T10:00:00.000Z",
  ultimaEm: "2025-03-02T10:00:00.000Z",
};

async function rota() {
  return import("@/app/api/v1/contacts/[id]/historico/route");
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
  h.contato = { id: CONTATO, phone_number: "+5511999999999", wa_lid: null };
  h.conversa = { id: CONVERSA, channel_session_id: SESSAO };
  h.sessao = { provider: "waha", waha_session_name: "org_x" };
  h.adapter = {
    resolveRecipient: (r: { phoneNumber?: string | null; waLid?: string | null }) =>
      r.waLid ? `${r.waLid}@lid` : r.phoneNumber ? `${r.phoneNumber.replace(/\D/g, "")}@c.us` : null,
    fetchChatHistory: vi.fn(async () => [mensagem("a"), mensagem("b")]),
  };
  h.importar.mockReset().mockResolvedValue(RESULTADO);
  h.audit.mockClear();
});

describe("POST /api/v1/contacts/:id/historico", () => {
  it("exige ao menos atendente: o veredito do requireRole passa direto", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "não", 403, { requestId: "r" }),
    });
    const { POST } = await rota();
    expect((await POST(pedido(), contexto())).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
    expect(h.importar).not.toHaveBeenCalled();
  });

  it("id que não é uuid → 400, sem tocar no banco", async () => {
    const { POST } = await rota();
    expect((await POST(pedido(), contexto("nao-e-uuid"))).status).toBe(400);
  });

  it("contato de outra empresa (RLS devolve nada) → 404", async () => {
    h.contato = null;
    const { POST } = await rota();
    expect((await POST(pedido(), contexto())).status).toBe(404);
    expect(h.importar).not.toHaveBeenCalled();
  });

  it("contato sem conversa 1:1 → 404 com motivo claro", async () => {
    h.conversa = null;
    const { POST } = await rota();
    const res = await POST(pedido(), contexto());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("no_conversation");
  });

  it("canal que não consulta o passado (API oficial) → 422, sem `if` de provider", async () => {
    delete h.adapter.fetchChatHistory;
    const { POST } = await rota();
    const res = await POST(pedido(), contexto());
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("history_not_supported");
  });

  it("canal sem histórico guardado → 409 que manda ligar o armazenamento", async () => {
    h.adapter.fetchChatHistory = vi.fn(async () => {
      throw new HistoricoIndisponivel();
    });
    const { POST } = await rota();
    const res = await POST(pedido(), contexto());
    expect(res.status).toBe(409);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("history_unavailable");
    expect(corpo.error.message).toMatch(/armazenamento/);
    expect(h.importar).not.toHaveBeenCalled();
  });

  it("canal fora do ar → 502, e NUNCA um sucesso com zero mensagens", async () => {
    h.adapter.fetchChatHistory = vi.fn(async () => {
      throw new Error("waha_timeout");
    });
    const { POST } = await rota();
    const res = await POST(pedido(), contexto());
    expect(res.status).toBe(502);
    expect(h.importar).not.toHaveBeenCalled();
  });

  it("contato sem número nem id opaco → 422", async () => {
    h.contato = { id: CONTATO, phone_number: null, wa_lid: null };
    const { POST } = await rota();
    expect((await POST(pedido(), contexto())).status).toBe(422);
  });

  it("busca por TODOS os endereços do contato (o id opaco e o telefone) e junta sem repetir", async () => {
    h.contato = { id: CONTATO, phone_number: "+5511999999999", wa_lid: "250302204792918" };
    const busca = vi.fn(async (p: { recipient: string }) =>
      p.recipient.endsWith("@lid") ? [mensagem("a"), mensagem("b")] : [mensagem("b"), mensagem("c")],
    );
    h.adapter.fetchChatHistory = busca;
    const { POST } = await rota();
    const res = await POST(pedido(), contexto());
    expect(res.status).toBe(200);
    expect(busca.mock.calls.map(([p]) => p.recipient).sort()).toEqual(["250302204792918@lid", "5511999999999@c.us"]);
    const enviadas = h.importar.mock.calls[0]![2] as MensagemDoHistorico[];
    expect(enviadas.map((m) => m.externalId).sort()).toEqual(["a", "b", "c"]);
  });

  it("se um endereço responde e o outro falha, importa o que veio (não é erro)", async () => {
    h.contato = { id: CONTATO, phone_number: "+5511999999999", wa_lid: "250302204792918" };
    h.adapter.fetchChatHistory = vi.fn(async (p: { recipient: string }) => {
      if (p.recipient.endsWith("@lid")) throw new Error("waha_404");
      return [mensagem("a")];
    });
    const { POST } = await rota();
    expect((await POST(pedido(), contexto())).status).toBe(200);
    expect(h.importar).toHaveBeenCalledTimes(1);
  });

  it("sucesso: devolve os números, grava com a organização da SESSÃO e audita sem texto de mensagem", async () => {
    const { POST } = await rota();
    const res = await POST(pedido(), contexto());
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      encontradas: 2,
      importadas: 2,
      de_anuncio: 1,
      contato_marcado_como_anuncio: true,
      limite_atingido: false,
    });
    expect(h.importar.mock.calls[0]![1]).toEqual({
      organizationId: ORG,
      contactId: CONTATO,
      conversationId: CONVERSA,
      channelSessionId: SESSAO,
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.history_imported",
        organizationId: ORG,
        resourceId: CONTATO,
        metadata: expect.not.objectContaining({ texto: expect.anything(), body: expect.anything() }),
      }),
    );
  });
});
