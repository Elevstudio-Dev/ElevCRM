import { describe, expect, it } from "vitest";

import { montarPublico, tipoDeTelefone, type ContatoCandidato } from "./publico";

function contato(over: Partial<ContatoCandidato>): ContatoCandidato {
  return {
    id: over.id ?? "c",
    phone_number: "+5511987654321",
    tags: ["base-odontocompany", "proc-limpeza"],
    is_blocked: false,
    papel_interno: null,
    is_anonymized: false,
    is_merged_into: null,
    ...over,
  };
}

describe("tipoDeTelefone", () => {
  it.each([
    ["+55 11 98765-4321", "celular"],
    ["11987654321", "celular"],
    ["5511987654321", "celular"],
    ["+551187654321", "celular"], // celular antigo, sem o 9
    ["+551133334444", "fixo"],
    ["1133334444", "fixo"],
    ["+5511887654321", "invalido"], // 9 dígitos sem começar em 9
    ["12345", "invalido"],
    [null, "invalido"],
    ["+351912345678", "celular"], // outro país
  ])("%s → %s", (telefone, esperado) => {
    expect(tipoDeTelefone(telefone)).toBe(esperado);
  });
});

describe("montarPublico", () => {
  it("exige TODAS as etiquetas e separa cada motivo de fora", () => {
    const publico = montarPublico(
      [
        contato({ id: "ok" }),
        contato({ id: "so-uma", tags: ["base-odontocompany"] }),
        contato({ id: "parar", is_blocked: true }),
        contato({ id: "fixo", phone_number: "+551133334444" }),
        contato({ id: "sem", phone_number: null }),
        contato({ id: "equipe", papel_interno: "dentista" }),
        contato({ id: "lgpd", is_anonymized: true }),
        contato({ id: "mesclado", is_merged_into: "outro" }),
        contato({ id: "maiuscula", tags: ["BASE-OdontoCompany", "Proc-Limpeza"] }),
      ],
      ["base-odontocompany", "proc-limpeza"],
    );
    expect(publico.incluidos).toEqual(["ok", "maiuscula"]);
    expect(publico.fora).toEqual({
      pediu_para_sair: 1,
      telefone_fixo: 1,
      sem_telefone: 1,
      equipe: 1,
      anonimizado: 2,
    });
  });
});
