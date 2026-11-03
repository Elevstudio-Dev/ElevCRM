import { describe, expect, it } from "vitest";

import {
  avisadosPeloTexto,
  mencoesPedidasSchema,
  resolverMencoes,
  type Marcavel,
} from "@/lib/mencoes/servidor";

const AUTOR = "00000000-0000-4000-8000-0000000000a0";
const ANA = "00000000-0000-4000-8000-0000000000a1";
const ANA2 = "00000000-0000-4000-8000-0000000000a2";
const BIA = "00000000-0000-4000-8000-0000000000b1";
const FORA = "00000000-0000-4000-8000-0000000000f0";

const marcaveis: Marcavel[] = [
  { user_id: AUTOR, role: "agent", full_name: "Autor Silva", email: "autor@x.com" },
  { user_id: ANA, role: "agent", full_name: "Ana Souza", email: "ana.souza@x.com" },
  { user_id: ANA2, role: "manager", full_name: "Ana Lima", email: "ana.lima@x.com" },
  { user_id: BIA, role: "agent", full_name: "Beatriz Alves", email: "bia@x.com" },
];

describe("resolverMencoes — o servidor não confia no navegador", () => {
  it("grava e avisa quem está na lista e ainda está no texto", () => {
    const r = resolverMencoes({
      texto: "oi @Ana Souza, vê isso",
      pedidas: [{ tipo: "pessoa", user_id: ANA }],
      marcaveis,
      autorId: AUTOR,
    });
    expect(r.gravar).toEqual([{ tipo: "pessoa", user_id: ANA, nome: "Ana Souza" }]);
    expect(r.avisar).toEqual([ANA]);
    expect(r.recusadas).toBe(0);
  });

  it("o NOME vem do servidor: o que o cliente mandar em `nome` não chega a lugar nenhum", () => {
    const pedida = { tipo: "pessoa", user_id: ANA, nome: "Diretor Geral" };
    const r = resolverMencoes({
      texto: "oi @Ana Souza",
      pedidas: mencoesPedidasSchema.parse([pedida]),
      marcaveis,
      autorId: AUTOR,
    });
    expect(r.gravar).toEqual([{ tipo: "pessoa", user_id: ANA, nome: "Ana Souza" }]);
  });

  it("recusa quem NÃO pode ser marcado ali (não enxerga a conversa, outra organização) e conta a recusa", () => {
    const r = resolverMencoes({
      texto: "oi @Fulano de Fora",
      pedidas: [{ tipo: "pessoa", user_id: FORA }],
      marcaveis,
      autorId: AUTOR,
    });
    expect(r.gravar).toEqual([]);
    expect(r.avisar).toEqual([]);
    expect(r.recusadas).toBe(1);
  });

  it("duas Anas: avisa só a que foi escolhida pelo id", () => {
    const r = resolverMencoes({
      texto: "@Ana Lima, pode ver?",
      pedidas: [{ tipo: "pessoa", user_id: ANA2 }],
      marcaveis,
      autorId: AUTOR,
    });
    expect(r.avisar).toEqual([ANA2]);
    expect(r.avisar).not.toContain(ANA);
  });

  it("apagou o nome do texto: não grava nem avisa", () => {
    const r = resolverMencoes({
      texto: "mudei de ideia",
      pedidas: [{ tipo: "pessoa", user_id: ANA }],
      marcaveis,
      autorId: AUTOR,
    });
    expect(r.gravar).toEqual([]);
    expect(r.avisar).toEqual([]);
  });

  it("@todos avisa todos os marcáveis — menos o autor — e nunca gente de fora da lista", () => {
    const r = resolverMencoes({
      texto: "bom dia @todos",
      pedidas: [{ tipo: "todos" }],
      marcaveis,
      autorId: AUTOR,
    });
    expect(r.gravar).toEqual([{ tipo: "todos" }]);
    expect(r.avisar.sort()).toEqual([ANA, ANA2, BIA].sort());
    expect(r.avisar).not.toContain(FORA);
  });

  it("o autor nunca avisa a si mesmo, nem marcando o próprio nome", () => {
    const r = resolverMencoes({
      texto: "anotei para @Autor Silva",
      pedidas: [{ tipo: "pessoa", user_id: AUTOR }],
      marcaveis,
      autorId: AUTOR,
    });
    expect(r.avisar).toEqual([]);
  });

  it("sem ninguém marcável (lista vazia), o @todos grava mas não avisa ninguém", () => {
    const r = resolverMencoes({ texto: "@todos", pedidas: [{ tipo: "todos" }], marcaveis: [], autorId: AUTOR });
    expect(r.avisar).toEqual([]);
  });

  it("a mesma pessoa pedida duas vezes é avisada uma vez só", () => {
    const r = resolverMencoes({
      texto: "@Ana Souza e @Ana Souza",
      pedidas: [
        { tipo: "pessoa", user_id: ANA },
        { tipo: "pessoa", user_id: ANA },
      ],
      marcaveis,
      autorId: AUTOR,
    });
    expect(r.gravar).toHaveLength(1);
    expect(r.avisar).toEqual([ANA]);
  });

  it("pessoa marcada + @todos: ninguém é avisado duas vezes", () => {
    const r = resolverMencoes({
      texto: "@Ana Souza @todos",
      pedidas: [{ tipo: "pessoa", user_id: ANA }, { tipo: "todos" }],
      marcaveis,
      autorId: AUTOR,
    });
    expect(new Set(r.avisar).size).toBe(r.avisar.length);
  });
});

describe("mencoesPedidasSchema — o formato aceito do navegador", () => {
  it("aceita pessoa com uuid e todos", () => {
    expect(mencoesPedidasSchema.parse([{ tipo: "pessoa", user_id: ANA }, { tipo: "todos" }])).toHaveLength(2);
  });
  it("sem o campo, vira lista vazia", () => {
    expect(mencoesPedidasSchema.parse(undefined)).toEqual([]);
  });
  it("recusa id que não é uuid", () => {
    expect(mencoesPedidasSchema.safeParse([{ tipo: "pessoa", user_id: "ana" }]).success).toBe(false);
  });
  it("recusa tipo desconhecido", () => {
    expect(mencoesPedidasSchema.safeParse([{ tipo: "grupo" }]).success).toBe(false);
  });
  it("recusa mais de 20 marcações", () => {
    const muitas = Array.from({ length: 21 }, () => ({ tipo: "todos" as const }));
    expect(mencoesPedidasSchema.safeParse(muitas).success).toBe(false);
  });
});

describe("avisadosPeloTexto — o comportamento antigo da nota, agora só entre quem vê a conversa", () => {
  it("o primeiro nome digitado à mão avisa", () => {
    expect(avisadosPeloTexto({ texto: "vê isso @beatriz", marcaveis, autorId: AUTOR })).toEqual([BIA]);
  });

  it("o começo do e-mail também", () => {
    expect(avisadosPeloTexto({ texto: "@bia pode olhar", marcaveis, autorId: AUTOR })).toEqual([BIA]);
  });

  it("quem não está na lista de marcáveis NUNCA é avisado, mesmo citado", () => {
    expect(avisadosPeloTexto({ texto: "@fulano", marcaveis: [], autorId: AUTOR })).toEqual([]);
  });

  it("sem @ no texto, ninguém", () => {
    expect(avisadosPeloTexto({ texto: "sem marcação", marcaveis, autorId: AUTOR })).toEqual([]);
  });

  it("o autor não se avisa", () => {
    expect(avisadosPeloTexto({ texto: "@autor", marcaveis, autorId: AUTOR })).toEqual([]);
  });
});
