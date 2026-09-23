import { describe, expect, it } from "vitest";

import {
  ehPlacaUtil,
  juntarTags,
  tagDaOs,
  tagDaPlaca,
  tagsDoEvento,
} from "@/lib/integrations/despachocerto/tags";

/**
 * AS TAGS DA OS E DA PLACA.
 *
 * Tag errada não dá erro: ela cria uma segunda tag quase igual, e a lista de
 * marcadores da organização apodrece em silêncio — `ABC1D23`, `abc-1d23` e
 * `ABC 1D23` viram três marcadores para um veículo só. Por isso a normalização
 * é provada aqui, antes de qualquer banco.
 *
 * O formato (`OS 1234` e a placa crua) é decisão do dono, 2026-09-22.
 */

describe("formato das tags", () => {
  it("a OS leva prefixo; a placa, não", () => {
    expect(tagDaOs("1234")).toBe("OS 1234");
    expect(tagDaPlaca("ABC1D23")).toBe("ABC1D23");
  });

  it("a mesma placa escrita de qualquer jeito vira UMA tag", () => {
    const formas = ["ABC1D23", "abc1d23", "ABC-1D23", "abc 1d23", " ABC-1D23 "];
    expect(new Set(formas.map(tagDaPlaca)).size).toBe(1);
  });

  it("o número da OS não é reescrito — é assim que a equipe o chama", () => {
    expect(tagDaOs("2026/0042")).toBe("OS 2026/0042");
    expect(tagDaOs("  77  ")).toBe("OS 77");
  });
});

describe("placa aproveitável", () => {
  it("aceita as placas reais, velha e Mercosul", () => {
    expect(ehPlacaUtil("ABC1234")).toBe(true);
    expect(ehPlacaUtil("ABC1D23")).toBe(true);
    expect(ehPlacaUtil("abc-1d23")).toBe(true);
  });

  it("recusa vazio, curto e lixo — tag de nada é pior que tag nenhuma", () => {
    expect(ehPlacaUtil(null)).toBe(false);
    expect(ehPlacaUtil(undefined)).toBe(false);
    expect(ehPlacaUtil("")).toBe(false);
    expect(ehPlacaUtil("   ")).toBe(false);
    expect(ehPlacaUtil("ABC")).toBe(false);
    expect(ehPlacaUtil("A/B*C1D2")).toBe(false);
  });
});

describe("tags de um evento de OS", () => {
  it("a OS mais cada placa, sem repetir a principal que veio também na lista", () => {
    expect(
      tagsDoEvento({ numero: "1234", placa: "ABC-1D23", placasAdicionais: ["abc1d23", "XYZ9K88"] }),
    ).toEqual(["OS 1234", "ABC1D23", "XYZ9K88"]);
  });

  it("OS sem placa ainda marca a OS", () => {
    expect(tagsDoEvento({ numero: "77" })).toEqual(["OS 77"]);
    expect(tagsDoEvento({ numero: "77", placa: null, placasAdicionais: [] })).toEqual(["OS 77"]);
  });
});

describe("juntar com as tags que já existem", () => {
  it("não duplica, e diz o que foi realmente acrescentado", () => {
    const r = juntarTags(["VIP", "OS 1234"], ["OS 1234", "ABC1D23"]);
    expect(r.todas).toEqual(["VIP", "OS 1234", "ABC1D23"]);
    expect(r.acrescentadas).toEqual(["ABC1D23"]);
  });

  it("nada novo → devolve o MESMO array, para o handler poder não escrever", () => {
    // Uma OS atualizada dez vezes no mesmo dia não pode gerar dez UPDATEs no
    // contato: cada escrita mexe em `updated_at` e acorda o tempo real do inbox.
    const existentes = ["OS 1234", "ABC1D23"];
    const r = juntarTags(existentes, ["OS 1234", "ABC1D23"]);
    expect(r.acrescentadas).toEqual([]);
    expect(r.todas).toBe(existentes);
  });

  it("contato sem tag nenhuma começa com as da OS", () => {
    expect(juntarTags(null, ["OS 9"]).todas).toEqual(["OS 9"]);
    expect(juntarTags(undefined, ["OS 9"]).acrescentadas).toEqual(["OS 9"]);
  });

  it("não mexe na caixa das tags que a equipe escreveu", () => {
    // "vip" da equipe continua "vip"; a integração só acrescenta as suas.
    expect(juntarTags(["vip"], ["OS 1"]).todas).toEqual(["vip", "OS 1"]);
  });
});
