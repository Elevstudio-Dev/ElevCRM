import { describe, expect, it } from "vitest";

import {
  aplicarMencao,
  filtrarCandidatos,
  gatilhoDeMencao,
  mencoesQueSobraram,
  trechosComMencao,
} from "@/lib/mencoes/texto";
import type { CandidatoDeMencao, Mencao } from "@/lib/mencoes/tipos";

const ANA: Mencao = { tipo: "pessoa", user_id: "u-ana", nome: "Ana" };
const ANA_SOUZA: Mencao = { tipo: "pessoa", user_id: "u-ana-souza", nome: "Ana Souza" };
const TODOS: Mencao = { tipo: "todos" };

describe("gatilhoDeMencao — o @ que o cursor está completando", () => {
  it("abre no começo do texto", () => {
    expect(gatilhoDeMencao("@", 1)).toEqual({ inicio: 0, consulta: "" });
  });

  it("abre depois de espaço e devolve o que foi digitado", () => {
    expect(gatilhoDeMencao("oi @an", 6)).toEqual({ inicio: 3, consulta: "an" });
  });

  it("abre depois de quebra de linha", () => {
    expect(gatilhoDeMencao("linha 1\n@bi", 11)).toEqual({ inicio: 8, consulta: "bi" });
  });

  it("aceita espaço na consulta, porque o nome tem sobrenome", () => {
    expect(gatilhoDeMencao("@Ana Sou", 8)).toEqual({ inicio: 0, consulta: "Ana Sou" });
  });

  it("NÃO abre no meio de um e-mail", () => {
    expect(gatilhoDeMencao("ana@empresa.com", 15)).toBeNull();
  });

  it("NÃO abre quando o @ ficou para trás de uma quebra de linha", () => {
    expect(gatilhoDeMencao("@ana\nmais uma linha", 19)).toBeNull();
  });

  it("NÃO abre quando virou frase (consulta longa demais)", () => {
    const frase = `@${"a".repeat(31)}`;
    expect(gatilhoDeMencao(frase, frase.length)).toBeNull();
  });

  it("olha só até o cursor: texto depois dele não conta", () => {
    expect(gatilhoDeMencao("oi @an e mais coisa", 6)).toEqual({ inicio: 3, consulta: "an" });
  });

  it("sem @ antes do cursor, nada", () => {
    expect(gatilhoDeMencao("sem arroba", 10)).toBeNull();
  });
});

describe("filtrarCandidatos — quem casa com o que foi digitado", () => {
  const todos: CandidatoDeMencao = { id: "todos", nome: "todos", todos: true };
  const lista: CandidatoDeMencao[] = [
    { id: "u-ana", nome: "Ana Souza" },
    { id: "u-jose", nome: "José Lima" },
    { id: "u-bia", nome: "Beatriz Alves" },
    todos,
  ];

  it("consulta vazia mostra todo mundo, com o @todos no topo", () => {
    expect(filtrarCandidatos(lista, "").map((c) => c.id)).toEqual(["todos", "u-ana", "u-jose", "u-bia"]);
  });

  it("casa pelo começo de QUALQUER palavra do nome", () => {
    expect(filtrarCandidatos(lista, "sou").map((c) => c.id)).toEqual(["u-ana"]);
    expect(filtrarCandidatos(lista, "alv").map((c) => c.id)).toEqual(["u-bia"]);
  });

  it("ignora acento e caixa dos dois lados", () => {
    expect(filtrarCandidatos(lista, "JOSE").map((c) => c.id)).toEqual(["u-jose"]);
    expect(filtrarCandidatos([{ id: "x", nome: "Jose Lima" }], "josé").map((c) => c.id)).toEqual(["x"]);
  });

  it("casa o nome completo com sobrenome", () => {
    expect(filtrarCandidatos(lista, "ana so").map((c) => c.id)).toEqual(["u-ana"]);
  });

  it("o @todos aparece quando a consulta é o começo de 'todos'", () => {
    expect(filtrarCandidatos(lista, "to").map((c) => c.id)).toEqual(["todos"]);
    expect(filtrarCandidatos(lista, "tx")).toEqual([]);
  });

  it("não casa no meio da palavra", () => {
    expect(filtrarCandidatos(lista, "ouza")).toEqual([]);
  });

  it("sem ninguém, lista vazia", () => {
    expect(filtrarCandidatos([], "a")).toEqual([]);
  });
});

describe("aplicarMencao — escolher alguém troca o @consulta pelo nome", () => {
  it("troca e põe o cursor depois do espaço", () => {
    const g = { inicio: 3, consulta: "an" };
    expect(aplicarMencao("oi @an", g, 6, "Ana Souza")).toEqual({
      texto: "oi @Ana Souza ",
      cursor: 14,
    });
  });

  it("preserva o que vinha depois do cursor", () => {
    const g = { inicio: 0, consulta: "a" };
    expect(aplicarMencao("@a, pode olhar?", g, 2, "Ana")).toEqual({
      texto: "@Ana , pode olhar?",
      cursor: 5,
    });
  });
});

describe("mencoesQueSobraram — só vale o nome que ainda está no texto", () => {
  it("mantém quem continua escrito", () => {
    expect(mencoesQueSobraram("oi @Ana, vê isso", [ANA])).toEqual([ANA]);
  });

  it("descarta quem teve o nome apagado", () => {
    expect(mencoesQueSobraram("oi, vê isso", [ANA])).toEqual([]);
  });

  it("@Ananda não é a Ana", () => {
    expect(mencoesQueSobraram("oi @Ananda", [ANA])).toEqual([]);
  });

  it("e-mail com o mesmo nome não é marcação", () => {
    expect(mencoesQueSobraram("fale com x@Ana.com", [ANA])).toEqual([]);
  });

  it("ignora caixa: @ana vale como @Ana", () => {
    expect(mencoesQueSobraram("oi @ana", [ANA])).toEqual([ANA]);
  });

  it("o @todos também some se o texto não o tem mais", () => {
    expect(mencoesQueSobraram("bom dia @todos", [TODOS])).toEqual([TODOS]);
    expect(mencoesQueSobraram("bom dia", [TODOS])).toEqual([]);
  });

  it("a mesma pessoa marcada duas vezes conta uma só", () => {
    expect(mencoesQueSobraram("@Ana e @Ana", [ANA, ANA])).toEqual([ANA]);
  });
});

describe("trechosComMencao — o texto cortado para a tela", () => {
  it("sem marcação, um trecho só", () => {
    expect(trechosComMencao("bom dia", [])).toEqual([{ texto: "bom dia" }]);
  });

  it("corta antes, no nome e depois", () => {
    expect(trechosComMencao("oi @Ana, tudo bem?", [ANA])).toEqual([
      { texto: "oi " },
      { texto: "@Ana", mencao: ANA },
      { texto: ", tudo bem?" },
    ]);
  });

  it("o nome mais longo ganha: @Ana Souza não vira @Ana + Souza", () => {
    expect(trechosComMencao("falar com @Ana Souza hoje", [ANA, ANA_SOUZA])).toEqual([
      { texto: "falar com " },
      { texto: "@Ana Souza", mencao: ANA_SOUZA },
      { texto: " hoje" },
    ]);
  });

  it("duas pessoas e o todos no mesmo texto, na ordem em que aparecem", () => {
    const t = trechosComMencao("@todos e @Ana", [ANA, TODOS]).filter((x) => x.mencao);
    expect(t.map((x) => x.texto)).toEqual(["@todos", "@Ana"]);
  });

  it("marca cada ocorrência", () => {
    const t = trechosComMencao("@Ana @Ana", [ANA]).filter((x) => x.mencao);
    expect(t).toHaveLength(2);
  });

  it("texto que não cita ninguém não ganha destaque", () => {
    expect(trechosComMencao("oi Ana", [ANA])).toEqual([{ texto: "oi Ana" }]);
  });

  it("a soma dos trechos é sempre o texto original", () => {
    const original = "oi @Ana Souza, @todos e @Ana\nlinha 2 @Ananda";
    const junto = trechosComMencao(original, [ANA, ANA_SOUZA, TODOS])
      .map((x) => x.texto)
      .join("");
    expect(junto).toBe(original);
  });
});
