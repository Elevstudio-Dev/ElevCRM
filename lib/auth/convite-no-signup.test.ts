/**
 * A bifurcação que impede o convidado de virar dono de uma empresa fantasma —
 * e, do outro lado, impede que um token alheio vire porta de entrada.
 *
 * Os dois erros possíveis aqui têm custos opostos e nenhum é aceitável:
 *  - deixar passar quando não devia → alguém entra em organização que não é
 *    dele, colando um token que interceptou;
 *  - provisionar quando havia convite → o defeito de origem volta, agora com um
 *    conserto por cima dando a impressão de estar resolvido.
 */
import { describe, expect, it } from "vitest";

import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { signInviteToken, verifyInviteToken } from "@/lib/auth/invite-token";

const ORG = "22222222-2222-4222-8222-222222222222";

function token(email: string, expEmSegundos = Math.floor(2_000_000_000)) {
  return signInviteToken({
    invite_id: "11111111-1111-4111-8111-111111111111",
    email,
    organization_id: ORG,
    role: "agent",
    exp: expEmSegundos,
  });
}

describe("decidirConviteDoSignup", () => {
  it("guarda de vacuidade: assinar e verificar funcionam", () => {
    // Se o par sign/verify estivesse quebrado, TODOS os casos abaixo cairiam em
    // "recusar" e o arquivo passaria dando a impressão de rigor.
    expect(verifyInviteToken(token("alguem@empresa.test"))).not.toBeNull();
  });

  it("sem convite na metadata: caminho normal, ganha a própria organização", () => {
    expect(decidirConviteDoSignup({ email: "novo@empresa.test" })).toEqual({
      tipo: "provisionar",
    });
    expect(decidirConviteDoSignup({ email: "novo@empresa.test", user_metadata: {} })).toEqual({
      tipo: "provisionar",
    });
  });

  it("convite válido para o mesmo e-mail: NÃO provisiona — vai para o aceite", () => {
    const t = token("convidado@empresa.test");
    const d = decidirConviteDoSignup({
      email: "convidado@empresa.test",
      user_metadata: { invite_token: t },
    });
    expect(d.tipo).toBe("convite");
    if (d.tipo === "convite") {
      expect(d.token).toBe(t);
      expect(d.payload.organization_id).toBe(ORG);
    }
  });

  it("caixa e espaço não decidem nada — o e-mail é o mesmo", () => {
    const d = decidirConviteDoSignup({
      email: "  Convidado@Empresa.Test ",
      user_metadata: { invite_token: token("convidado@empresa.test") },
    });
    expect(d.tipo).toBe("convite");
  });

  it("token de OUTRA pessoa: recusa — nunca entra na organização alheia", () => {
    // O caso que justifica a comparação existir: `user_metadata` é gravável
    // pelo próprio usuário, então colar aqui o token que chegou para outra
    // pessoa é trivial. O que não é adulterável é o e-mail que o provedor de
    // auth confirmou.
    const d = decidirConviteDoSignup({
      email: "atacante@outro.test",
      user_metadata: { invite_token: token("vitima@empresa.test") },
    });
    expect(d).toEqual({ tipo: "recusar", motivo: "email_divergente" });
  });

  it("token expirado: recusa, e NUNCA cai no provisionamento", () => {
    // Falha fechada. Cair em "provisionar" aqui devolveria exatamente o bug
    // original para quem demorasse entre criar a conta e confirmar o e-mail.
    const d = decidirConviteDoSignup({
      email: "convidado@empresa.test",
      user_metadata: { invite_token: token("convidado@empresa.test", 1) },
    });
    expect(d).toEqual({ tipo: "recusar", motivo: "token_invalido" });
  });

  it("token adulterado: recusa, e NUNCA cai no provisionamento", () => {
    const t = token("convidado@empresa.test");
    const adulterado = `${t.slice(0, -3)}xyz`;
    const d = decidirConviteDoSignup({
      email: "convidado@empresa.test",
      user_metadata: { invite_token: adulterado },
    });
    expect(d).toEqual({ tipo: "recusar", motivo: "token_invalido" });
  });

  it("metadata com lixo no lugar do token não vira convite nem quebra", () => {
    for (const lixo of [42, null, {}, [], "   "]) {
      expect(decidirConviteDoSignup({ email: "a@b.test", user_metadata: { invite_token: lixo } })).toEqual(
        { tipo: "provisionar" },
      );
    }
  });
});

/**
 * O CADASTRO FECHADO — instalação operada como serviço, onde cliente entra por
 * convite. Este é o ÚNICO ponto que cria organização para quem se cadastra, então
 * é aqui que o fechamento tem de valer: fechar só na tela deixaria o `/auth/v1/signup`
 * do próprio Auth (anon key, direto do navegador) criar organização do mesmo jeito.
 */
describe("decidirConviteDoSignup com o cadastro público FECHADO", () => {
  const fechado = { cadastroAberto: false };

  it("sem convite: RECUSA — não ganha organização", () => {
    expect(decidirConviteDoSignup({ email: "estranho@qualquer.test" }, fechado)).toEqual({
      tipo: "recusar",
      motivo: "cadastro_fechado",
    });
    expect(decidirConviteDoSignup({ email: "estranho@qualquer.test", user_metadata: {} }, fechado)).toEqual({
      tipo: "recusar",
      motivo: "cadastro_fechado",
    });
  });

  it("lixo no lugar do token não é convite: continua recusando", () => {
    for (const lixo of [42, null, {}, [], "   "]) {
      expect(
        decidirConviteDoSignup({ email: "a@b.test", user_metadata: { invite_token: lixo } }, fechado),
      ).toEqual({ tipo: "recusar", motivo: "cadastro_fechado" });
    }
  });

  it("COM convite válido para o mesmo e-mail: entra — é o caminho de todo cliente", () => {
    const t = token("dono@clinica.test");
    const d = decidirConviteDoSignup(
      { email: "dono@clinica.test", user_metadata: { invite_token: t } },
      fechado,
    );
    expect(d.tipo).toBe("convite");
  });

  it("convite de OUTRA pessoa continua recusado, e pelo motivo certo (não vira 'cadastro fechado')", () => {
    const d = decidirConviteDoSignup(
      { email: "atacante@outro.test", user_metadata: { invite_token: token("vitima@clinica.test") } },
      fechado,
    );
    expect(d).toEqual({ tipo: "recusar", motivo: "email_divergente" });
  });

  it("convite expirado continua `token_invalido` — quem tinha convite merece saber que ele venceu", () => {
    const d = decidirConviteDoSignup(
      { email: "dono@clinica.test", user_metadata: { invite_token: token("dono@clinica.test", 1) } },
      fechado,
    );
    expect(d).toEqual({ tipo: "recusar", motivo: "token_invalido" });
  });

  it("quem JÁ TEM organização não é barrado: o fechamento vale para criar, não para confirmar outro link", () => {
    // Troca de e-mail e link mágico também passam por `/auth/confirm`. Esse usuário já é
    // membro de uma organização, então `provisionar` é um no-op idempotente — recusá-lo
    // só o jogaria num erro de "cadastro fechado" sem ter cadastro nenhum a fazer.
    expect(
      decidirConviteDoSignup({ email: "membro@clinica.test" }, { cadastroAberto: false, jaTemOrganizacao: true }),
    ).toEqual({ tipo: "provisionar" });
  });

  it("`jaTemOrganizacao` NÃO atravessa convite inválido: token ruim segue recusado pelo motivo certo", () => {
    const d = decidirConviteDoSignup(
      { email: "dono@clinica.test", user_metadata: { invite_token: token("dono@clinica.test", 1) } },
      { cadastroAberto: false, jaTemOrganizacao: true },
    );
    expect(d).toEqual({ tipo: "recusar", motivo: "token_invalido" });
  });

  it("sem dizer que já tem organização, o padrão é NÃO ter — falha fechada", () => {
    expect(decidirConviteDoSignup({ email: "x@y.test" }, { cadastroAberto: false })).toEqual({
      tipo: "recusar",
      motivo: "cadastro_fechado",
    });
  });

  it("com o cadastro ABERTO (ou sem opção) nada muda: quem já instalou segue como antes", () => {
    expect(decidirConviteDoSignup({ email: "novo@empresa.test" }, { cadastroAberto: true })).toEqual({
      tipo: "provisionar",
    });
    expect(decidirConviteDoSignup({ email: "novo@empresa.test" }, {})).toEqual({ tipo: "provisionar" });
  });
});
