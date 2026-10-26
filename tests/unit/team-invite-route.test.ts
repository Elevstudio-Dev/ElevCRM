/**
 * POST /api/v1/team/invite — o que a rota entrega, preso ANTES de a assinatura do convite
 * ser extraída para `lib/team/emitir-convite.ts` (que a rota de plataforma também usa).
 *
 * Esta rota só tinha cobertura de ponta a ponta (`tests/e2e/invite-lifecycle.spec.ts`), que
 * não roda no gate local. Refatorar um caminho de segurança sem teste que o prenda é
 * trocar o motor com o carro andando: o teste vem primeiro, passa contra o código antigo, e
 * tem de continuar passando contra o novo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/resend";
import { verifyInviteToken } from "@/lib/auth/invite-token";

const { env } = vi.hoisted(() => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com.br/",
    INVITE_TOKEN_SECRET: "segredo-de-teste-do-convite-0123456789",
  },
}));

vi.mock("@/lib/env", () => ({ env }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/branding/saida", async (original) => ({
  ...(await original<typeof import("@/lib/branding/saida")>()),
  marcaDaSaida: vi.fn(async () => ({
    nome: "Marca do Teste",
    logoUrl: null,
    accent: "#506d48",
    accentFg: "#ffffff",
    origens: { nome: "padrao", cor: "padrao" },
  })),
}));

import { POST } from "@/app/api/v1/team/invite/route";

const ORG = "22222222-2222-4222-8222-222222222222";
const ADMIN = "11111111-1111-4111-8111-111111111111";

function comMembros(emails: string[]) {
  const membros = emails.map((_, i) => ({ user_id: `membro-${i}` }));
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({
      select: () => ({ eq: () => ({ is: async () => ({ data: membros, error: null }) }) }),
    }),
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { email: emails[Number(id.replace("membro-", ""))] } },
        }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const chamar = (invitations: Array<{ email: string; role: string }>) =>
  POST(
    new NextRequest("https://crm.exemplo.com.br/api/v1/team/invite", {
      method: "POST",
      body: JSON.stringify({ invitations }),
      headers: { "content-type": "application/json" },
    }),
  );

describe("POST /api/v1/team/invite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: ADMIN, email: "chefe@clinica.test", full_name: "Chefe da Clínica" },
      org: { orgId: ORG, name: "Clínica Sorriso", role: "admin" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never);
    comMembros([]);
  });

  it("convida: normaliza o e-mail, assina um token que vale para a organização e o papel pedidos", async () => {
    // Maiúsculas viram minúsculas; espaço em volta nem chega aqui (o schema recusa com 422).
    const res = await chamar([{ email: "Nova.Pessoa@Clinica.TEST", role: "agent" }]);
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as {
      data: { sent: Array<Record<string, unknown>>; failed: unknown[] };
    };
    expect(data.failed).toEqual([]);
    expect(data.sent).toHaveLength(1);
    const item = data.sent[0] as { email: string; accept_url: string; email_dispatched: boolean; invite_id: string };
    expect(item.email).toBe("nova.pessoa@clinica.test");
    expect(item.email_dispatched).toBe(true);

    // A barra final de NEXT_PUBLIC_APP_URL não pode virar `//` no link.
    expect(item.accept_url).toMatch(/^https:\/\/crm\.exemplo\.com\.br\/team\/accept-invite\/[^/]+$/);
    const token = item.accept_url.split("/team/accept-invite/")[1] ?? "";
    expect(verifyInviteToken(token)).toMatchObject({
      invite_id: item.invite_id,
      email: "nova.pessoa@clinica.test",
      organization_id: ORG,
      role: "agent",
    });
  });

  it("envia o e-mail pela marca da saída, com as tags que a operação filtra", async () => {
    await chamar([{ email: "nova@clinica.test", role: "manager" }]);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "nova@clinica.test",
        fromName: "Marca do Teste",
        tags: [
          { name: "kind", value: "team_invite" },
          { name: "org", value: ORG },
        ],
      }),
    );
    const enviado = vi.mocked(sendEmail).mock.calls[0]?.[0] as { subject: string };
    expect(enviado.subject).toContain("Chefe da Clínica");
    expect(enviado.subject).toContain("Clínica Sorriso");
  });

  it("audita `member.invited` por convite, com o resultado do envio", async () => {
    await chamar([{ email: "nova@clinica.test", role: "viewer" }]);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.invited",
        actorUserId: ADMIN,
        organizationId: ORG,
        resourceType: "membership",
        metadata: { email: "nova@clinica.test", role: "viewer", email_dispatched: true, email_error: null },
      }),
    );
    // Convite de admin da própria organização NÃO é ação de plataforma.
    expect(vi.mocked(audit).mock.calls[0]?.[0]).not.toHaveProperty("actingAsPlatformAdmin");
  });

  it("e-mail que não sai NÃO derruba o convite: o link continua na resposta e o erro vai ao audit", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: "domain not verified" } as never);

    const res = await chamar([{ email: "nova@clinica.test", role: "agent" }]);
    const { data } = (await res.json()) as { data: { sent: Array<{ email_dispatched: boolean; accept_url: string }> } };

    expect(data.sent[0]?.email_dispatched).toBe(false);
    expect(data.sent[0]?.accept_url).toContain("/team/accept-invite/");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ email_dispatched: false, email_error: "domain not verified" }),
      }),
    );
  });

  it("quem já é membro ativo é pulado: `already_member`, sem e-mail e sem audit", async () => {
    comMembros(["Ja.Membro@Clinica.test"]);

    const res = await chamar([{ email: "ja.membro@clinica.test", role: "agent" }]);
    const { data } = (await res.json()) as { data: { sent: unknown[]; failed: Array<{ email: string; reason: string }> } };

    expect(data.sent).toEqual([]);
    expect(data.failed).toEqual([{ email: "ja.membro@clinica.test", reason: "already_member" }]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("lote misto: convida o novo e pula o membro, na ordem pedida", async () => {
    comMembros(["ja.membro@clinica.test"]);

    const res = await chamar([
      { email: "ja.membro@clinica.test", role: "agent" },
      { email: "novo@clinica.test", role: "agent" },
    ]);
    const { data } = (await res.json()) as { data: { sent: Array<{ email: string }>; failed: Array<{ email: string }> } };

    expect(data.failed.map((f) => f.email)).toEqual(["ja.membro@clinica.test"]);
    expect(data.sent.map((s) => s.email)).toEqual(["novo@clinica.test"]);
  });

  it("sem permissão de admin devolve a resposta do requireRole e não emite nada", async () => {
    const negado = new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: negado } as any);

    const res = await chamar([{ email: "nova@clinica.test", role: "admin" }]);

    expect(res.status).toBe(403);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
