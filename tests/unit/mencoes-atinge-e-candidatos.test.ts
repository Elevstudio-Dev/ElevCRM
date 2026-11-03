import { describe, expect, it } from "vitest";

import { chatMarcaUsuario, lerMencoes, notaMarcaUsuario } from "@/lib/mencoes/atinge";
import { candidatosDaEquipe, mencaoDaEquipe } from "@/lib/mencoes/candidatos";
import { mencoesDaEquipeParaApi } from "@/lib/mencoes/api";

const EU = { id: "u-eu", email: "eu@x.com", full_name: "Eduardo Lima" };

describe("lerMencoes — a coluna que veio solta do banco", () => {
  it("aceita as três formas e descarta o resto", () => {
    expect(
      lerMencoes([
        { tipo: "pessoa", user_id: "u1", nome: "Ana" },
        { tipo: "todos" },
        { tipo: "participante", jid: "55119@c.us", nome: "Cliente" },
        { tipo: "pessoa", user_id: 7, nome: "sem uuid string" },
        "lixo",
        null,
        { tipo: "outra" },
      ]),
    ).toEqual([
      { tipo: "pessoa", user_id: "u1", nome: "Ana" },
      { tipo: "todos" },
      { tipo: "participante", jid: "55119@c.us", nome: "Cliente" },
    ]);
  });
  it("não-lista vira lista vazia", () => {
    expect(lerMencoes(null)).toEqual([]);
    expect(lerMencoes({ tipo: "todos" })).toEqual([]);
    expect(lerMencoes(undefined)).toEqual([]);
  });
});

describe("notaMarcaUsuario — o aviso na tela de quem recebe a nota pelo tempo real", () => {
  it("marcação guardada com o MEU id acende", () => {
    expect(
      notaMarcaUsuario({
        mentions: [{ tipo: "pessoa", user_id: EU.id, nome: "Eduardo Lima" }],
        body: "@Eduardo Lima olha",
        user: EU,
      }),
    ).toBe(true);
  });

  it("marcação guardada de OUTRA pessoa não acende, mesmo que o texto case com o meu nome", () => {
    expect(
      notaMarcaUsuario({
        mentions: [{ tipo: "pessoa", user_id: "u-outro-eduardo", nome: "Eduardo Souza" }],
        body: "@Eduardo Souza olha",
        user: EU,
      }),
    ).toBe(false);
  });

  it("@todos NÃO acende o aviso na tela: a linha da nota chega a qualquer membro da organização", () => {
    expect(notaMarcaUsuario({ mentions: [{ tipo: "todos" }], body: "@todos", user: EU })).toBe(false);
  });

  it("sem marcação guardada, vale o texto digitado à mão (comportamento antigo)", () => {
    expect(notaMarcaUsuario({ mentions: [], body: "vê isso @eduardo", user: EU })).toBe(true);
    expect(notaMarcaUsuario({ mentions: undefined, body: "sem ninguém", user: EU })).toBe(false);
  });
});

describe("chatMarcaUsuario — o aviso do chat da equipe", () => {
  it("pessoa: pelo meu id", () => {
    expect(chatMarcaUsuario([{ tipo: "pessoa", user_id: EU.id, nome: "Eduardo" }], EU.id)).toBe("pessoa");
  });
  it("@todos vale aqui (a linha só chega a quem enxerga o canal)", () => {
    expect(chatMarcaUsuario([{ tipo: "todos" }], EU.id)).toBe("todos");
  });
  it("pessoa vence todos quando as duas valem", () => {
    expect(
      chatMarcaUsuario([{ tipo: "todos" }, { tipo: "pessoa", user_id: EU.id, nome: "Eduardo" }], EU.id),
    ).toBe("pessoa");
  });
  it("outra pessoa marcada, nada", () => {
    expect(chatMarcaUsuario([{ tipo: "pessoa", user_id: "u-x", nome: "X" }], EU.id)).toBeNull();
    expect(chatMarcaUsuario(undefined, EU.id)).toBeNull();
  });
});

describe("candidatosDaEquipe / mencaoDaEquipe", () => {
  const rotulo = (r: string) => `papel:${r}`;
  const lista = [
    { user_id: "u1", nome: "Ana Souza", role: "agent" },
    { user_id: "u2", nome: "Caio", role: "manager" },
  ];

  it("põe o @todos no topo e o papel no detalhe", () => {
    const c = candidatosDaEquipe(lista, rotulo);
    expect(c[0]).toEqual({ id: "todos", nome: "todos", todos: true });
    expect(c.slice(1)).toEqual([
      { id: "u1", nome: "Ana Souza", detalhe: "papel:agent" },
      { id: "u2", nome: "Caio", detalhe: "papel:manager" },
    ]);
  });

  it("sem colegas, sem nada — e lista vazia desliga o @ no campo", () => {
    expect(candidatosDaEquipe([], rotulo)).toEqual([]);
  });

  it("a linha escolhida vira a marcação certa", () => {
    expect(mencaoDaEquipe({ id: "todos", nome: "todos", todos: true })).toEqual({ tipo: "todos" });
    expect(mencaoDaEquipe({ id: "u1", nome: "Ana Souza" })).toEqual({
      tipo: "pessoa",
      user_id: "u1",
      nome: "Ana Souza",
    });
  });
});

describe("mencoesDaEquipeParaApi — o que sai do navegador", () => {
  it("manda só tipo e id (nunca o nome) e deixa o participante de WhatsApp de fora", () => {
    expect(
      mencoesDaEquipeParaApi([
        { tipo: "pessoa", user_id: "u1", nome: "Ana" },
        { tipo: "todos" },
        { tipo: "participante", jid: "55@c.us", nome: "Cliente" },
      ]),
    ).toEqual([{ tipo: "pessoa", user_id: "u1" }, { tipo: "todos" }]);
  });
});
