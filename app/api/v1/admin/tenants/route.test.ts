import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/resend";
import { verifyInviteToken } from "@/lib/auth/invite-token";

/**
 * POST /api/v1/admin/tenants — a plataforma abre a organização de um cliente.
 *
 * Até aqui a rota criava a organização e JOGAVA FORA o `owner_email`: ele só entrava no
 * audit, em hash. A organização nascia sem ninguém dentro, e o operador não tinha como
 * entregar o acesso ao cliente sem abrir o banco. Agora a mesma chamada emite o convite
 * de ADMIN para o dono, e devolve o link — que vale 24h e entra pelo caminho de convite,
 * o único que cria conta com o cadastro público fechado.
 *
 * Os desfechos presos aqui: org criada + convite de admin para ESTA org; e-mail que não
 * sai não derruba nada (o link vem na resposta); falha ao emitir não desfaz a org nem vira 500
 * (o operador reemite pela outra rota); slug repetido não emite convite nenhum.
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

import { POST } from "@/app/api/v1/admin/tenants/route";

const PLATAFORMA = "11111111-1111-4111-8111-111111111111";
const NOVA_ORG = "44444444-4444-4444-8444-444444444444";

function bancoQue(resultadoDoInsert: { data: unknown; error: { code?: string; message: string } | null }) {
  const insert = vi.fn(() => ({ select: () => ({ single: async () => resultadoDoInsert }) }));
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({ insert }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return insert;
}

const corpo = {
  display_name: "Clínica Sorriso",
  slug: "clinica-sorriso",
  plan: "pro",
  owner_email: "Dono@Clinica.TEST",
};

const chamar = (body: unknown) =>
  POST(
    new NextRequest("https://crm.exemplo.com.br/api/v1/admin/tenants", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

type Resposta = {
  data: {
    id: string;
    slug: string;
    display_name: string;
    owner_invite: { email: string; accept_url: string; email_dispatched: boolean } | null;
    owner_invite_error?: string;
  };
};

describe("POST /api/v1/admin/tenants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      user: { id: PLATAFORMA, email: "carlos@elev.test", user_metadata: { full_name: "Carlos da Elev" } },
      platformAdmin: { user_id: PLATAFORMA, scope: "full", mfa_required: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never);
    bancoQue({ data: { id: NOVA_ORG, slug: "clinica-sorriso", display_name: "Clínica Sorriso" }, error: null });
  });

  it("cria a organização e emite o convite de ADMIN para o dono, amarrado a ESTA organização", async () => {
    const res = await chamar(corpo);
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as Resposta;
    expect(data).toMatchObject({ id: NOVA_ORG, slug: "clinica-sorriso", display_name: "Clínica Sorriso" });
    expect(data.owner_invite?.email).toBe("dono@clinica.test");
    expect(data.owner_invite?.email_dispatched).toBe(true);

    const token = data.owner_invite?.accept_url.split("/team/accept-invite/")[1] ?? "";
    expect(verifyInviteToken(token)).toMatchObject({
      email: "dono@clinica.test",
      organization_id: NOVA_ORG,
      role: "admin",
    });
  });

  it("o e-mail sai pela marca da instalação e em nome de quem opera a plataforma", async () => {
    await chamar(corpo);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "dono@clinica.test", fromName: "Elev Studio" }),
    );
    expect((vi.mocked(sendEmail).mock.calls[0]?.[0] as { subject: string }).subject).toContain("Carlos da Elev");
  });

  it("audita o convite como ação de plataforma, além da criação do tenant", async () => {
    await chamar(corpo);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.invited",
        actorUserId: PLATAFORMA,
        organizationId: NOVA_ORG,
        actingAsPlatformAdmin: true,
        metadata: expect.objectContaining({ email: "dono@clinica.test", role: "admin" }),
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tenant.created_by_platform_admin", organizationId: NOVA_ORG }),
    );
  });

  it("e-mail que não sai NÃO derruba a criação: o link vem na resposta para o operador entregar", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: "domain not verified" } as never);

    const res = await chamar(corpo);
    const { data } = (await res.json()) as Resposta;

    expect(res.status).toBe(201);
    expect(data.owner_invite?.email_dispatched).toBe(false);
    expect(data.owner_invite?.accept_url).toContain("/team/accept-invite/");
  });

  it("falha ao EMITIR o convite não desfaz a organização nem vira 500: avisa e deixa reemitir", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("rede caiu"));

    const res = await chamar(corpo);
    const { data } = (await res.json()) as Resposta;

    expect(res.status).toBe(201);
    expect(data.id).toBe(NOVA_ORG);
    expect(data.owner_invite).toBeNull();
    expect(data.owner_invite_error).toBe("invite_failed");
  });

  it("slug repetido: 409 e NENHUM convite emitido", async () => {
    bancoQue({ data: null, error: { code: "23505", message: "duplicate key" } });

    const res = await chamar(corpo);

    expect(res.status).toBe(409);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("quem não é admin de plataforma: 403, nada é criado nem enviado", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("NEXT_REDIRECT"));
    const insert = bancoQue({ data: null, error: null });

    const res = await chamar(corpo);

    expect(res.status).toBe(403);
    expect(insert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("e-mail do dono inválido: 400 antes de criar qualquer coisa", async () => {
    const insert = bancoQue({ data: null, error: null });

    const res = await chamar({ ...corpo, owner_email: "isto-nao-e-email" });

    expect(res.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
