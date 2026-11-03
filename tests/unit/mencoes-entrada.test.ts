import { describe, expect, it } from "vitest";

import { nomearMencoesDeEntrada, nomesPorNumero } from "@/lib/mencoes/entrada";
import { trechosComMencao } from "@/lib/mencoes/texto";

const nomes = new Map([
  ["117137179947104", "Gabriel Lima"],
  ["5511999990001", "Maria Souza"],
]);

describe("nomearMencoesDeEntrada — o @<número> que chega vira o nome", () => {
  it("o caso do print: a mensagem que é SÓ o número marcado", () => {
    const r = nomearMencoesDeEntrada("@117137179947104", nomes);
    expect(r.texto).toBe("@Gabriel Lima");
    expect(r.mencoes).toEqual([{ tipo: "participante", jid: "117137179947104@c.us", nome: "Gabriel Lima" }]);
  });

  it("no meio da frase, e mais de uma pessoa", () => {
    const r = nomearMencoesDeEntrada("oi @117137179947104 e @5511999990001, vejam isso", nomes);
    expect(r.texto).toBe("oi @Gabriel Lima e @Maria Souza, vejam isso");
    expect(r.mencoes).toHaveLength(2);
  });

  it("o resultado casa com o destaque: cada nome vira um trecho marcado", () => {
    const r = nomearMencoesDeEntrada("oi @117137179947104 e @5511999990001", nomes);
    const marcados = trechosComMencao(r.texto, r.mencoes).filter((t) => t.mencao).map((t) => t.texto);
    expect(marcados).toEqual(["@Gabriel Lima", "@Maria Souza"]);
  });

  it("número SEM nome conhecido fica como chegou — não inventa", () => {
    const r = nomearMencoesDeEntrada("@999999999999 oi", nomes);
    expect(r.texto).toBe("@999999999999 oi");
    expect(r.mencoes).toEqual([]);
  });

  it("a mesma pessoa duas vezes: troca as duas, uma marcação só", () => {
    const r = nomearMencoesDeEntrada("@5511999990001 e de novo @5511999990001", nomes);
    expect(r.texto).toBe("@Maria Souza e de novo @Maria Souza");
    expect(r.mencoes).toHaveLength(1);
  });

  it("não mexe em número que não é marcação: e-mail, número colado em letra, número curto", () => {
    expect(nomearMencoesDeEntrada("x@5511999990001.com", nomes).texto).toBe("x@5511999990001.com");
    expect(nomearMencoesDeEntrada("@5511999990001abc", nomes).texto).toBe("@5511999990001abc");
    expect(nomearMencoesDeEntrada("@1234", nomes).texto).toBe("@1234");
    expect(nomearMencoesDeEntrada("ligue 5511999990001", nomes).texto).toBe("ligue 5511999990001");
  });

  it("sem participantes conhecidos, o corpo passa intacto", () => {
    expect(nomearMencoesDeEntrada("@117137179947104", new Map())).toEqual({ texto: "@117137179947104", mencoes: [] });
  });

  it("mantém quebra de linha e espaços ao redor", () => {
    expect(nomearMencoesDeEntrada("linha 1\n@117137179947104\nlinha 3", nomes).texto).toBe("linha 1\n@Gabriel Lima\nlinha 3");
  });
});

describe("nomesPorNumero", () => {
  it("indexa pelo endereço E pelo telefone, e só de quem tem nome de verdade", () => {
    const m = nomesPorNumero([
      { jid: "117137179947104@lid", nome: "Gabriel Lima", telefone: "5511999990009", conhecido: true },
      { jid: "5511999990002@c.us", nome: "+5511999990002", telefone: "5511999990002", conhecido: false },
    ]);
    expect(m.get("117137179947104")).toBe("Gabriel Lima");
    expect(m.get("5511999990009")).toBe("Gabriel Lima");
    expect(m.has("5511999990002")).toBe(false);
  });
});
