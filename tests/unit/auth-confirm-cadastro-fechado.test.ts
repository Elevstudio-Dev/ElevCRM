/**
 * COM O CADASTRO PÚBLICO FECHADO, `/auth/confirm` NÃO CRIA ORGANIZAÇÃO PARA ESTRANHO.
 *
 * `/auth/confirm` é o ÚNICO ponto que provisiona organização para quem se cadastra
 * sozinho. Fechar o cadastro só na tela `/signup` não fecha nada: o endpoint
 * `/auth/v1/signup` do próprio Auth aceita a anon key direto do navegador, e quem
 * confirma o e-mail cai aqui do mesmo jeito. Por isso o fechamento mora neste ponto.
 *
 * Os quatro desfechos que importam, nesta ordem de gravidade:
 *  - fechado + sem convite + sem vínculo → NADA é criado (o caso que motivou tudo);
 *  - fechado + convite válido            → entra pelo aceite (é o caminho de todo cliente);
 *  - fechado + JÁ É MEMBRO               → segue como sempre (troca de e-mail, link mágico);
 *  - aberto                              → nada muda, e nem se consulta o vínculo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser, organizacaoAtivaDoUsuario } from "@/lib/auth/provision";
import { signInviteToken } from "@/lib/auth/invite-token";

const { env } = vi.hoisted(() => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com.br",
    INVITE_TOKEN_SECRET: "segredo-de-teste-do-convite-0123456789",
    CADASTRO_PUBLICO: undefined as string | undefined,
  },
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/provision", () => ({
  ensureTenantForUser: vi.fn(async () => ({ provisioned: true })),
  organizacaoAtivaDoUsuario: vi.fn(async () => null),
}));
vi.mock("@/lib/env", () => ({ env }));

import { GET } from "@/app/auth/confirm/route";

const USUARIO = "33333333-3333-4333-8333-333333333333";

function supabaseQue(user: { email: string; user_metadata?: Record<string, unknown> }) {
  const resposta = { data: { user: { id: USUARIO, ...user } }, error: null };
  vi.mocked(createClient).mockResolvedValue({
    auth: { verifyOtp: vi.fn(async () => resposta), exchangeCodeForSession: vi.fn(async () => resposta) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function destino(): Promise<string> {
  const res = await GET(new NextRequest("https://crm.exemplo.com.br/auth/confirm?token_hash=abc&type=signup"));
  const loc = new URL(res.headers.get("location") ?? "");
  return loc.pathname + loc.search;
}

describe("/auth/confirm com o cadastro público", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.CADASTRO_PUBLICO = undefined;
    vi.mocked(organizacaoAtivaDoUsuario).mockResolvedValue(null);
  });

  it("FECHADO, sem convite, sem vínculo: recusa, NÃO provisiona e audita o motivo", async () => {
    env.CADASTRO_PUBLICO = "false";
    supabaseQue({ email: "estranho@qualquer.test" });

    expect(await destino()).toBe("/login?error=cadastro_fechado");

    expect(ensureTenantForUser).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signup_provision_recusado",
        actorUserId: USUARIO,
        metadata: { motivo: "cadastro_fechado" },
      }),
    );
  });

  it("FECHADO com erro de digitação (`falso`): continua fechado — falha fechada", async () => {
    env.CADASTRO_PUBLICO = "falso";
    supabaseQue({ email: "estranho@qualquer.test" });

    expect(await destino()).toBe("/login?error=cadastro_fechado");
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("FECHADO + convite válido para o mesmo e-mail: vai para o aceite, sem criar organização", async () => {
    env.CADASTRO_PUBLICO = "false";
    const token = signInviteToken({
      invite_id: "11111111-1111-4111-8111-111111111111",
      email: "dono@clinica.test",
      organization_id: "22222222-2222-4222-8222-222222222222",
      role: "admin",
      exp: Math.floor(2_000_000_000),
    });
    supabaseQue({ email: "dono@clinica.test", user_metadata: { invite_token: token } });

    expect(await destino()).toBe(`/team/accept-invite/${token}`);
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("FECHADO + convite de OUTRA pessoa: recusa pelo motivo do convite, não por 'cadastro fechado'", async () => {
    env.CADASTRO_PUBLICO = "false";
    const token = signInviteToken({
      invite_id: "11111111-1111-4111-8111-111111111111",
      email: "vitima@clinica.test",
      organization_id: "22222222-2222-4222-8222-222222222222",
      role: "admin",
      exp: Math.floor(2_000_000_000),
    });
    supabaseQue({ email: "atacante@outro.test", user_metadata: { invite_token: token } });

    expect(await destino()).toBe("/login?error=convite_invalido");
    expect(ensureTenantForUser).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { motivo: "email_divergente" } }),
    );
  });

  it("FECHADO, mas JÁ É MEMBRO (troca de e-mail, link mágico): segue como sempre", async () => {
    env.CADASTRO_PUBLICO = "false";
    vi.mocked(organizacaoAtivaDoUsuario).mockResolvedValue("22222222-2222-4222-8222-222222222222");
    supabaseQue({ email: "membro@clinica.test" });

    expect(await destino()).toBe("/onboarding/welcome");
    // `ensureTenantForUser` é o no-op idempotente que já existia para quem tem vínculo.
    expect(ensureTenantForUser).toHaveBeenCalledTimes(1);
    expect(organizacaoAtivaDoUsuario).toHaveBeenCalledWith(USUARIO);
  });

  it("ABERTO: provisiona como sempre e nem consulta o vínculo", async () => {
    env.CADASTRO_PUBLICO = undefined;
    supabaseQue({ email: "novo@empresa.test" });

    expect(await destino()).toBe("/onboarding/welcome");
    expect(ensureTenantForUser).toHaveBeenCalledTimes(1);
    expect(organizacaoAtivaDoUsuario).not.toHaveBeenCalled();
  });

  it("ABERTO com `true` explícito: igual a ausente", async () => {
    env.CADASTRO_PUBLICO = "true";
    supabaseQue({ email: "novo@empresa.test" });

    expect(await destino()).toBe("/onboarding/welcome");
    expect(ensureTenantForUser).toHaveBeenCalledTimes(1);
  });
});
