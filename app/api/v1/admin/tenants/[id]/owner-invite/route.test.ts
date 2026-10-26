import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/resend";
import { verifyInviteToken } from "@/lib/auth/invite-token";

/**
 * POST /api/v1/admin/tenants/[id]/owner-invite — a plataforma (re)emite o convite do dono.
 *
 * O convite vale 24h e não tem linha em tabela: se o cliente demorou, perdeu o e-mail ou o
 * e-mail nunca saiu, a única saída era recriar o tenant. Esta rota assina um convite de
 * ADMIN novo para uma organização que já existe.
 *
 * O que ela precisa garantir: só plataforma chama; só organização ATIVA recebe (convidar
 * para suspensa ou redigida por LGPD não leva a lugar nenhum e confunde o operador); o
 * papel é sempre `admin`, nunca vindo do corpo; e o convite carrega o id da organização
 * da URL, não um de quem chama.
 */

const { env } = vi.hoisted(() => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com.br",
    INVITE_TOKEN_SECRET: "segredo-de-teste-do-convite-0123456789",
  },
}));

vi.mock("@/lib/env", () => ({ env }));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/branding/saida", async (original) => ({
  ...(await original<typeof import("@/lib/branding/saida")>()),
  marcaDaSaida: vi.fn(async () => ({
    nome: "Elev Studio",
    logoUrl: null,
    accent: "#506d48",
    accentFg: "#ffffff",
    origens: { nome: "padrao", cor: "padrao" },
  })),
}));

import { POST } from "@/app/api/v1/admin/tenants/[id]/owner-invite/route";

const PLATAFORMA = "11111111-1111-4111-8111-111111111111";
const ORG = "44444444-4444-4444-8444-444444444444";

function bancoQue(org: { id: string; display_name: string; status: string } | null) {
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: org, error: null }) }) }) }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const chamar = (body: unknown, id = ORG) =>
  POST(
    new NextRequest(`https://crm.exemplo.com.br/api/v1/admin/tenants/${id}/owner-invite`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  );

type Resposta = { data: { owner_invite: { email: string; accept_url: string; email_dispatched: boolean } } };

describe("POST /api/v1/admin/tenants/[id]/owner-invite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      user: { id: PLATAFORMA, email: "carlos@elev.test", user_metadata: {} },
      platformAdmin: { user_id: PLATAFORMA, scope: "full", mfa_required: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never);
    bancoQue({ id: ORG, display_name: "Clínica Sorriso", status: "active" });
  });

  it("emite um convite de ADMIN novo, amarrado à organização da URL", async () => {
    const res = await chamar({ email: "Dono@Clinica.TEST" });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as Resposta;
    expect(data.owner_invite.email).toBe("dono@clinica.test");
    const token = data.owner_invite.accept_url.split("/team/accept-invite/")[1] ?? "";
    expect(verifyInviteToken(token)).toMatchObject({
      email: "dono@clinica.test",
      organization_id: ORG,
      role: "admin",
    });
  });

  it("o papel é SEMPRE admin: um `role` mandado no corpo é ignorado", async () => {
    const res = await chamar({ email: "dono@clinica.test", role: "viewer" });
    const { data } = (await res.json()) as Resposta;

    const token = data.owner_invite.accept_url.split("/team/accept-invite/")[1] ?? "";
    expect(verifyInviteToken(token)?.role).toBe("admin");
  });

  it("audita como ação de plataforma", async () => {
    await chamar({ email: "dono@clinica.test" });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.invited",
        actorUserId: PLATAFORMA,
        organizationId: ORG,
        actingAsPlatformAdmin: true,
      }),
    );
  });

  it("e-mail que não sai: continua 201 e o link vem na resposta", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: "sem chave" } as never);

    const res = await chamar({ email: "dono@clinica.test" });
    const { data } = (await res.json()) as Resposta;

    expect(res.status).toBe(201);
    expect(data.owner_invite.email_dispatched).toBe(false);
    expect(data.owner_invite.accept_url).toContain("/team/accept-invite/");
  });

  it.each(["suspended", "redacted"])("organização %s: 409, sem convite", async (status) => {
    bancoQue({ id: ORG, display_name: "Clínica Sorriso", status });

    const res = await chamar({ email: "dono@clinica.test" });

    expect(res.status).toBe(409);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("organização que não existe: 404", async () => {
    bancoQue(null);

    const res = await chamar({ email: "dono@clinica.test" });

    expect(res.status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("id que não é UUID: 400 sem tocar no banco", async () => {
    const res = await chamar({ email: "dono@clinica.test" }, "nao-e-uuid");

    expect(res.status).toBe(400);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("e-mail inválido ou ausente: 400", async () => {
    expect((await chamar({ email: "isto-nao-e-email" })).status).toBe(400);
    expect((await chamar({})).status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("quem não é admin de plataforma: 403, nada é enviado", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("NEXT_REDIRECT"));

    const res = await chamar({ email: "dono@clinica.test" });

    expect(res.status).toBe(403);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
