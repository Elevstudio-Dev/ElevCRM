/**
 * A AÇÃO `signUp` RECUSA ANTES DE GASTAR E-MAIL QUANDO O CADASTRO ESTÁ FECHADO.
 *
 * A trava que de fato impede a organização fantasma mora em `/auth/confirm`
 * (ver `auth-confirm-cadastro-fechado.test.ts`). Esta aqui é a cortesia que vem
 * antes: sem ela, um robô preencheria o formulário, o GoTrue mandaria um e-mail de
 * confirmação para cada tentativa (cota de envio do cliente) e só no clique o
 * cadastro seria recusado. Recusar na ação poupa o e-mail e dá a resposta certa
 * na hora.
 *
 * Quem traz convite ASSINADO e para o mesmo e-mail passa — é como todo cliente entra.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";
import { signInviteToken } from "@/lib/auth/invite-token";

const { env } = vi.hoisted(() => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com.br",
    INVITE_TOKEN_SECRET: "segredo-de-teste-do-convite-0123456789",
    CADASTRO_PUBLICO: undefined as string | undefined,
  },
}));

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), hashEmail: (e: string) => `h:${e}` }));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: vi.fn(async () => false),
  AUTH_LIMITS: { signup: { limit: 5, windowSeconds: 3600 } },
}));
vi.mock("@/lib/env", () => ({ env }));

import { signUp } from "@/app/actions/auth/signUp";

const SENHA = "SenhaForte#2026x";
const dados = (email: string) => ({
  org_name: "Clínica Sorriso",
  email,
  password: SENHA,
  password_confirm: SENHA,
});
const dadosDeConvite = (email: string) => ({ email, password: SENHA, password_confirm: SENHA });

function tokenPara(email: string) {
  return signInviteToken({
    invite_id: "11111111-1111-4111-8111-111111111111",
    email,
    organization_id: "22222222-2222-4222-8222-222222222222",
    role: "admin",
    exp: Math.floor(2_000_000_000),
  });
}

function supabase() {
  const signUpDoAuth = vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null }));
  vi.mocked(createClient).mockResolvedValue({
    auth: { signUp: signUpDoAuth },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return signUpDoAuth;
}

describe("signUp com o cadastro público", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.CADASTRO_PUBLICO = undefined;
  });

  it("FECHADO, sem convite: recusa e NÃO pede e-mail de confirmação ao Auth", async () => {
    env.CADASTRO_PUBLICO = "false";
    const signUpDoAuth = supabase();

    const res = await signUp(dados("estranho@qualquer.test"));

    expect(res).toEqual({ ok: false, error: "cadastro_fechado" });
    expect(signUpDoAuth).not.toHaveBeenCalled();
  });

  it("FECHADO, token em branco não é convite", async () => {
    env.CADASTRO_PUBLICO = "false";
    const signUpDoAuth = supabase();

    const res = await signUp(dados("estranho@qualquer.test"), "   ");

    expect(res).toEqual({ ok: false, error: "cadastro_fechado" });
    expect(signUpDoAuth).not.toHaveBeenCalled();
  });

  it("FECHADO + convite válido para o mesmo e-mail: cria a conta carregando o token", async () => {
    env.CADASTRO_PUBLICO = "false";
    const signUpDoAuth = supabase();
    const token = tokenPara("dono@clinica.test");

    const res = await signUp(dadosDeConvite("dono@clinica.test"), token);

    expect(res).toEqual({ ok: true });
    expect(signUpDoAuth).toHaveBeenCalledTimes(1);
    expect(signUpDoAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "dono@clinica.test",
        options: expect.objectContaining({ data: { invite_token: token } }),
      }),
    );
  });

  it("FECHADO + convite de OUTRO e-mail: continua recusado pelo motivo do convite", async () => {
    env.CADASTRO_PUBLICO = "false";
    const signUpDoAuth = supabase();

    const res = await signUp(dadosDeConvite("atacante@outro.test"), tokenPara("vitima@clinica.test"));

    expect(res).toMatchObject({ ok: false, error: "validation_error", details: { invite: ["email_divergente"] } });
    expect(signUpDoAuth).not.toHaveBeenCalled();
  });

  it("ABERTO: cria a conta pedindo a organização, como sempre", async () => {
    const signUpDoAuth = supabase();

    const res = await signUp(dados("novo@empresa.test"));

    expect(res).toEqual({ ok: true });
    expect(signUpDoAuth).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ data: { org_name: "Clínica Sorriso" } }) }),
    );
  });
});
