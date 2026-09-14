import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * O TOKEN DE CONVITE NÃO SE ASSINA COM UMA STRING DO REPOSITÓRIO EM PRODUÇÃO.
 *
 * `lib/auth/invite-token.ts` resolve o segredo pelo `env` validado
 * (`INVITE_TOKEN_SECRET → INTERNAL_SECRET → "dev-fallback"`). O terceiro degrau
 * existe para os unitários assinarem sem ambiente — e `lib/env.ts` já impede
 * que produção suba sem `INTERNAL_SECRET`. Mas a última linha de defesa não
 * pode depender da primeira: um token assinado com "dev-fallback" é um token
 * que qualquer pessoa com o código-fonte forja, e o convite dá acesso a uma
 * organização inteira. Em produção, sem segredo: assinar recusa alto, e
 * verificar devolve `null` — sem lançar, porque a verificação roda no render
 * da página pública de cadastro.
 *
 * O módulo lê `env`, que é congelado no import: cada caso reimporta com o
 * ambiente que quer (`vi.resetModules` + `vi.stubEnv`), como fazem os outros
 * testes que exercitam `lib/env` de verdade.
 *
 * Nasceu da auditoria de 2026-09-03 (threat model, T4), fechada em 2026-09-13
 * e revista no code-review de 2026-09-14.
 */

const PAYLOAD = {
  invite_id: "00000000-0000-0000-0000-000000000001",
  email: "pessoa@exemplo.com",
  organization_id: "00000000-0000-0000-0000-000000000002",
  role: "agent",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const SEGREDO = "um-segredo-de-verdade-com-tamanho-suficiente";

async function moduloCom(ambiente: { INTERNAL_SECRET: string; INVITE_TOKEN_SECRET: string }) {
  vi.resetModules();
  vi.stubEnv("INTERNAL_SECRET", ambiente.INTERNAL_SECRET);
  vi.stubEnv("INVITE_TOKEN_SECRET", ambiente.INVITE_TOKEN_SECRET);
  return import("@/lib/auth/invite-token");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("o segredo do token de convite", () => {
  it("em produção, sem segredo nenhum, assinar recusa — e verificar devolve null sem lançar", async () => {
    const { signInviteToken, verifyInviteToken } = await moduloCom({
      INTERNAL_SECRET: "",
      INVITE_TOKEN_SECRET: "",
    });
    // NODE_ENV é lido na CHAMADA, não no import: o `env` acima foi validado em
    // modo teste (onde INTERNAL_SECRET vazio é aceito) e só agora viramos produção.
    vi.stubEnv("NODE_ENV", "production");
    expect(() => signInviteToken(PAYLOAD)).toThrow(/INTERNAL_SECRET/);
    expect(verifyInviteToken("corpo.assinatura")).toBeNull();
  });

  it("em produção, com INTERNAL_SECRET, assina e verifica normalmente", async () => {
    const { signInviteToken, verifyInviteToken } = await moduloCom({
      INTERNAL_SECRET: SEGREDO,
      INVITE_TOKEN_SECRET: "",
    });
    vi.stubEnv("NODE_ENV", "production");
    expect(verifyInviteToken(signInviteToken(PAYLOAD))).toEqual(PAYLOAD);
  });

  it("INVITE_TOKEN_SECRET vazio não é um segredo de zero caracteres — cai em INTERNAL_SECRET", async () => {
    const a = await moduloCom({ INTERNAL_SECRET: SEGREDO, INVITE_TOKEN_SECRET: "" });
    const token = a.signInviteToken(PAYLOAD);
    const b = await moduloCom({ INTERNAL_SECRET: SEGREDO, INVITE_TOKEN_SECRET: "" });
    expect(b.verifyInviteToken(token)).toEqual(PAYLOAD);
  });

  it("fora de produção o fallback continua valendo — os unitários assinam sem ambiente", async () => {
    const { signInviteToken, verifyInviteToken } = await moduloCom({
      INTERNAL_SECRET: "",
      INVITE_TOKEN_SECRET: "",
    });
    vi.stubEnv("NODE_ENV", "test");
    expect(verifyInviteToken(signInviteToken(PAYLOAD))).toEqual(PAYLOAD);
  });

  it("um token assinado com o fallback não verifica contra o segredo real", async () => {
    const semSegredo = await moduloCom({ INTERNAL_SECRET: "", INVITE_TOKEN_SECRET: "" });
    const forjado = semSegredo.signInviteToken(PAYLOAD);
    const comSegredo = await moduloCom({ INTERNAL_SECRET: SEGREDO, INVITE_TOKEN_SECRET: "" });
    expect(comSegredo.verifyInviteToken(forjado)).toBeNull();
  });
});
