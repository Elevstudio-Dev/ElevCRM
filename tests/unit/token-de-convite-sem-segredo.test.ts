import { afterEach, describe, expect, it, vi } from "vitest";

import { signInviteToken, verifyInviteToken } from "@/lib/auth/invite-token";

/**
 * O TOKEN DE CONVITE NÃO SE ASSINA COM UMA STRING DO REPOSITÓRIO EM PRODUÇÃO.
 *
 * `lib/auth/invite-token.ts` resolve o segredo como
 * `INVITE_TOKEN_SECRET → INTERNAL_SECRET → "dev-fallback"`. O terceiro degrau
 * existe para os unitários assinarem sem ambiente — e `lib/env.ts` já impede
 * que produção suba sem `INTERNAL_SECRET`. Mas a última linha de defesa não
 * pode depender de outro módulo: um token assinado com "dev-fallback" é um
 * token que qualquer pessoa com o código-fonte forja, e o convite dá acesso a
 * uma organização inteira. Em produção, sem segredo, recusa alto.
 *
 * Nasceu da auditoria de 2026-09-03 (threat model, "segredo de convite com
 * fallback de desenvolvimento"), fechada em 2026-09-13.
 */

const PAYLOAD = {
  invite_id: "00000000-0000-0000-0000-000000000001",
  email: "pessoa@exemplo.com",
  organization_id: "00000000-0000-0000-0000-000000000002",
  role: "agent",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("o segredo do token de convite", () => {
  it("em produção, sem segredo nenhum, recusa em vez de assinar com o fallback", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INVITE_TOKEN_SECRET", "");
    vi.stubEnv("INTERNAL_SECRET", "");
    expect(() => signInviteToken(PAYLOAD)).toThrow(/INTERNAL_SECRET/);
  });

  it("em produção, com INTERNAL_SECRET, assina e verifica normalmente", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INVITE_TOKEN_SECRET", "");
    vi.stubEnv("INTERNAL_SECRET", "um-segredo-de-verdade-com-tamanho-suficiente");
    const token = signInviteToken(PAYLOAD);
    expect(verifyInviteToken(token)).toEqual(PAYLOAD);
  });

  it("fora de produção o fallback continua valendo — os unitários assinam sem ambiente", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INVITE_TOKEN_SECRET", "");
    vi.stubEnv("INTERNAL_SECRET", "");
    const token = signInviteToken(PAYLOAD);
    expect(verifyInviteToken(token)).toEqual(PAYLOAD);
  });

  it("um token assinado com o fallback não verifica contra o segredo real", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INVITE_TOKEN_SECRET", "");
    vi.stubEnv("INTERNAL_SECRET", "");
    const forjado = signInviteToken(PAYLOAD);
    vi.stubEnv("INTERNAL_SECRET", "um-segredo-de-verdade-com-tamanho-suficiente");
    expect(verifyInviteToken(forjado)).toBeNull();
  });
});
