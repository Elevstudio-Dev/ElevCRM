import { describe, expect, it } from "vitest";

import {
  candidatosDoGrupo,
  digitosDoJid,
  jidParaEnvio,
  mencaoDeGrupo,
  mencoesDeGrupoPedidasSchema,
  prepararMencoesDeGrupo,
} from "@/lib/mencoes/grupo";
import type { Mencao } from "@/lib/mencoes/tipos";

const MARIA: Mencao = { tipo: "participante", jid: "5511999990001@c.us", nome: "Maria Souza" };
const LID: Mencao = { tipo: "participante", jid: "117137179947104@lid", nome: "+117137179947104" };
const TODOS: Mencao = { tipo: "todos" };

describe("prepararMencoesDeGrupo — do texto da atendente ao que sai para o grupo", () => {
  it("troca @Nome por @<número>, que é o que o WhatsApp desenha como o nome da pessoa", () => {
    const p = prepararMencoesDeGrupo("oi @Maria Souza, tudo bem?", [MARIA]);
    expect(p.textoDeEnvio).toBe("oi @5511999990001, tudo bem?");
    expect(p.jids).toEqual(["5511999990001@c.us"]);
    expect(p.todos).toBe(false);
  });

  it("o que a atendente lê no CRM continua sendo @Nome: `gravar` guarda o nome", () => {
    const p = prepararMencoesDeGrupo("oi @Maria Souza", [MARIA]);
    expect(p.gravar).toEqual([MARIA]);
  });

  it("participante @lid (quem esconde o número) vai pelo id oculto", () => {
    const p = prepararMencoesDeGrupo("@+117137179947104 pode ver?", [LID]);
    expect(p.textoDeEnvio).toBe("@117137179947104 pode ver?");
    expect(p.jids).toEqual(["117137179947104@lid"]);
  });

  it("@todos fica no texto e liga `todos` — quem marca o grupo inteiro é o canal", () => {
    const p = prepararMencoesDeGrupo("@todos reunião às 15h", [TODOS]);
    expect(p.textoDeEnvio).toBe("@todos reunião às 15h");
    expect(p.todos).toBe(true);
    expect(p.jids).toEqual([]);
  });

  it("duas pessoas e o todos no mesmo texto", () => {
    const p = prepararMencoesDeGrupo("@todos, @Maria Souza e @+117137179947104", [MARIA, LID, TODOS]);
    expect(p.textoDeEnvio).toBe("@todos, @5511999990001 e @117137179947104");
    expect(p.jids.sort()).toEqual(["117137179947104@lid", "5511999990001@c.us"]);
    expect(p.todos).toBe(true);
  });

  it("quem teve o nome apagado do texto NÃO é marcado", () => {
    const p = prepararMencoesDeGrupo("mudei de ideia", [MARIA]);
    expect(p.jids).toEqual([]);
    expect(p.gravar).toEqual([]);
    expect(p.textoDeEnvio).toBe("mudei de ideia");
  });

  it("a mesma pessoa citada duas vezes sai uma vez só na lista de endereços", () => {
    const p = prepararMencoesDeGrupo("@Maria Souza e de novo @Maria Souza", [MARIA]);
    expect(p.jids).toEqual(["5511999990001@c.us"]);
    expect(p.textoDeEnvio).toBe("@5511999990001 e de novo @5511999990001");
  });

  it("não troca texto que só PARECE o nome: e-mail e prefixo de outro nome ficam como estão", () => {
    const p = prepararMencoesDeGrupo("escreva para x@Maria Souza.com ou @Maria Souzana", [MARIA]);
    expect(p.textoDeEnvio).toBe("escreva para x@Maria Souza.com ou @Maria Souzana");
    expect(p.jids).toEqual([]);
  });

  it("marcação de EQUIPE não entra no envio do grupo (é de outro caminho)", () => {
    const p = prepararMencoesDeGrupo("@Ana", [{ tipo: "pessoa", user_id: "u1", nome: "Ana" }]);
    expect(p.jids).toEqual([]);
    expect(p.gravar).toEqual([]);
  });

  it("@s.whatsapp.net vai ao canal como @c.us", () => {
    const p = prepararMencoesDeGrupo("@Zé", [{ tipo: "participante", jid: "5511888880002@s.whatsapp.net", nome: "Zé" }]);
    expect(p.jids).toEqual(["5511888880002@c.us"]);
    expect(p.textoDeEnvio).toBe("@5511888880002");
  });
});

describe("jid", () => {
  it("dígitos e endereço de envio", () => {
    expect(digitosDoJid("5511999990001@c.us")).toBe("5511999990001");
    expect(jidParaEnvio("5511999990001@c.us")).toBe("5511999990001@c.us");
    expect(jidParaEnvio("5511999990001@s.whatsapp.net")).toBe("5511999990001@c.us");
    expect(jidParaEnvio("117137179947104@lid")).toBe("117137179947104@lid");
  });
});

describe("mencoesDeGrupoPedidasSchema — o que o navegador pode mandar", () => {
  it("aceita participante com endereço válido e todos", () => {
    const r = mencoesDeGrupoPedidasSchema.safeParse([
      { tipo: "participante", jid: "5511999990001@c.us", nome: "Maria" },
      { tipo: "todos" },
    ]);
    expect(r.success).toBe(true);
  });

  it("recusa endereço que não é de participante (grupo, texto livre, vazio)", () => {
    for (const jid of ["120363401969475450@g.us", "maria", "", "55@c.us", "5511999990001@outro.com", "5511999990001@c.us\n"]) {
      expect(
        mencoesDeGrupoPedidasSchema.safeParse([{ tipo: "participante", jid, nome: "X" }]).success,
      ).toBe(false);
    }
  });

  it("recusa nome com quebra de linha ou vazio, e mais de 20 marcações", () => {
    expect(
      mencoesDeGrupoPedidasSchema.safeParse([{ tipo: "participante", jid: "5511999990001@c.us", nome: "a\nb" }]).success,
    ).toBe(false);
    expect(
      mencoesDeGrupoPedidasSchema.safeParse([{ tipo: "participante", jid: "5511999990001@c.us", nome: "  " }]).success,
    ).toBe(false);
    expect(mencoesDeGrupoPedidasSchema.safeParse(Array.from({ length: 21 }, () => ({ tipo: "todos" }))).success).toBe(false);
  });
});

describe("candidatosDoGrupo / mencaoDeGrupo", () => {
  const ps = [
    { jid: "5511999990001@c.us", nome: "Maria Souza", telefone: "5511999990001", admin: false, conhecido: true },
    { jid: "117137179947104@lid", nome: "Participante 947104", telefone: null, admin: true, conhecido: false },
    { jid: "5511999990003@c.us", nome: "+5511999990003", telefone: "5511999990003", admin: false, conhecido: false },
  ];

  it("@todos no topo, depois os participantes", () => {
    const c = candidatosDoGrupo(ps, "admin do grupo");
    expect(c.map((x) => x.id)).toEqual(["todos", "5511999990001@c.us", "117137179947104@lid", "5511999990003@c.us"]);
    expect(c[0]!.todos).toBe(true);
  });

  it("a linha pequena traz o telefone (se o nome é outra coisa) e o admin", () => {
    const c = candidatosDoGrupo(ps, "admin do grupo");
    expect(c[1]!.detalhe).toBe("+5511999990001");
    expect(c[2]!.detalhe).toBe("admin do grupo"); // sem telefone: só o admin
    expect(c[3]!.detalhe).toBeNull(); // o nome JÁ é o número: não se repete
  });

  it("grupo sem participante conhecido: nada (o @ vira um caractere comum)", () => {
    expect(candidatosDoGrupo([], "admin")).toEqual([]);
  });

  it("a linha escolhida vira a marcação do grupo", () => {
    expect(mencaoDeGrupo({ id: "todos", nome: "todos", todos: true })).toEqual({ tipo: "todos" });
    expect(mencaoDeGrupo({ id: "5511999990001@c.us", nome: "Maria Souza" })).toEqual({
      tipo: "participante",
      jid: "5511999990001@c.us",
      nome: "Maria Souza",
    });
  });
});
