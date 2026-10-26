import { describe, expect, it } from "vitest";

import { renderTemplateBody } from "@/lib/channels/meta/render-template";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";

import {
  campoDoSlot,
  dadosDoLembrete,
  formatarData,
  formatarHora,
  limparParametro,
  montarValores,
  primeiroNome,
  problemasDoModelo,
  textoPadraoDoLembrete,
} from "./valores";

const INICIO = new Date("2026-10-26T17:00:00Z"); // segunda, 14:00 em Brasília

const dados = dadosDoLembrete({
  inicio: INICIO,
  fuso: "America/Sao_Paulo",
  nomeDoContato: "MARIA da Silva",
  servico: "Avaliação",
  profissional: "Dra. Ana",
  localReal: "Av. Brasil, 100 — sala 3",
  clinica: "Sorriso Perfeito",
});

const botoes = {
  type: "BUTTONS",
  buttons: [
    { type: "QUICK_REPLY", text: "Confirmo" },
    { type: "QUICK_REPLY", text: "Preciso remarcar" },
  ],
};

const posicional = deriveTemplateContract({
  name: "lembrete_consulta",
  language: "pt_BR",
  parameter_format: "POSITIONAL",
  components: [
    {
      type: "BODY",
      text: "Olá {{1}}! Seu horário: {{4}}, {{2}} às {{3}}, com {{5}}. Local: {{6}}.",
    },
    botoes,
  ],
});

const nomeado = deriveTemplateContract({
  name: "lembrete_consulta_nomeado",
  language: "pt_BR",
  parameter_format: "NAMED",
  components: [
    { type: "BODY", text: "Olá {{nome}}! {{servico}} em {{data}} às {{hora}} — {{clinica}}." },
    botoes,
  ],
});

describe("formatação no fuso do compromisso", () => {
  it("data em pt-BR com dia da semana", () => {
    expect(formatarData(INICIO, "America/Sao_Paulo")).toBe("segunda-feira, 26/10");
  });

  it("hora em 24 h", () => {
    expect(formatarHora(INICIO, "America/Sao_Paulo")).toBe("14:00");
    expect(formatarHora(new Date("2026-10-26T09:05:00Z"), "America/Sao_Paulo")).toBe("06:05");
  });

  it("o mesmo instante lê diferente em outro fuso — e vira outro dia quando é o caso", () => {
    const quaseMeiaNoite = new Date("2026-10-27T02:30:00Z");
    expect(formatarHora(quaseMeiaNoite, "America/Sao_Paulo")).toBe("23:30");
    expect(formatarData(quaseMeiaNoite, "America/Sao_Paulo")).toBe("segunda-feira, 26/10");
    expect(formatarData(quaseMeiaNoite, "UTC")).toBe("terça-feira, 27/10");
  });
});

describe("primeiroNome", () => {
  it.each([
    ["MARIA da Silva", "Maria"],
    ["joão", "João"],
    ["👑 Ana Paula", "Ana"],
    ["  d'Ávila Souza", "D'ávila"],
    ["Maria-Clara", "Maria-clara"],
  ])("%s → %s", (entrada, esperado) => {
    expect(primeiroNome(entrada)).toBe(esperado);
  });

  it.each([null, undefined, "", "   ", "👑🔥", "12345"])(
    "sem letra nenhuma (%j) cai em 'paciente' — nunca vazio",
    (entrada) => {
      expect(primeiroNome(entrada)).toBe("paciente");
    },
  );
});

describe("dadosDoLembrete", () => {
  it("monta os sete dados e guarda o endereço real à parte", () => {
    expect(dados).toEqual({
      nome: "Maria",
      data: "segunda-feira, 26/10",
      hora: "14:00",
      servico: "Avaliação",
      profissional: "Dra. Ana",
      local: "Av. Brasil, 100 — sala 3",
      clinica: "Sorriso Perfeito",
      localReal: "Av. Brasil, 100 — sala 3",
    });
  });

  it("sem endereço, `local` cai para a clínica mas `localReal` continua nulo", () => {
    const d = dadosDoLembrete({
      inicio: INICIO,
      fuso: "America/Sao_Paulo",
      nomeDoContato: null,
      servico: "Retorno",
      profissional: null,
      localReal: "  ",
      clinica: "Sorriso Perfeito",
    });
    expect(d.local).toBe("Sorriso Perfeito");
    expect(d.localReal).toBeNull();
    expect(d.profissional).toBe("a nossa equipe");
    expect(d.nome).toBe("paciente");
  });

  it("sem nome de clínica nenhum, não deixa buraco", () => {
    const d = dadosDoLembrete({
      inicio: INICIO,
      fuso: "America/Sao_Paulo",
      nomeDoContato: "Ana",
      servico: "",
      profissional: "Dr. Beto",
      localReal: null,
      clinica: undefined,
    });
    expect(d.clinica).toBe("nossa clínica");
    expect(d.servico).toBe("atendimento");
  });
});

describe("textoPadraoDoLembrete", () => {
  it("diz quem, o quê, quando e como remarcar", () => {
    const t = textoPadraoDoLembrete(dados);
    expect(t).toContain("Olá, Maria!");
    expect(t).toContain("Avaliação, segunda-feira, 26/10 às 14:00");
    expect(t).toContain("com Dra. Ana");
    expect(t).toContain("Local: Av. Brasil, 100 — sala 3.");
    expect(t).toContain("é só responder esta mensagem");
  });

  it("não inventa linha de local quando não há endereço", () => {
    expect(textoPadraoDoLembrete({ ...dados, localReal: null })).not.toContain("Local:");
  });
});

describe("o mapeamento de slots é convenção, não tela", () => {
  it("posicional: 1=nome 2=data 3=hora 4=serviço 5=profissional 6=local", () => {
    const campos = posicional.slots.map((s) => campoDoSlot(s, "POSITIONAL"));
    // ordem dos slots no TEXTO: {{1}} {{4}} {{2}} {{3}} {{5}} {{6}}
    expect(campos).toEqual(["nome", "servico", "data", "hora", "profissional", "local"]);
  });

  it("nomeado: usa o nome da variável, com sinônimos e sem depender de acento", () => {
    const campo = (key: string) =>
      campoDoSlot(
        { address: { kind: "body" }, key, expects: "text", contextBefore: "", contextAfter: "" },
        "NAMED",
      );
    expect(campo("nome")).toBe("nome");
    expect(campo("primeiro_nome")).toBe("nome");
    expect(campo("Horário")).toBe("hora");
    expect(campo("SERVIÇO")).toBe("servico");
    expect(campo("dentista")).toBe("profissional");
    expect(campo("endereco")).toBe("local");
    expect(campo("empresa")).toBe("clinica");
    expect(campo("cor_do_cabelo")).toBeNull();
  });

  it("posicional fora da faixa 1–6 ou não numérico é desconhecido", () => {
    const campo = (key: string) =>
      campoDoSlot(
        { address: { kind: "body" }, key, expects: "text", contextBefore: "", contextAfter: "" },
        "POSITIONAL",
      );
    expect(campo("0")).toBeNull();
    expect(campo("7")).toBeNull();
    expect(campo("nome")).toBeNull();
  });
});

describe("montarValores", () => {
  it("modelo posicional: preenche cada slot e o texto renderizado sai certo", () => {
    const r = montarValores(posicional, dados);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values).toEqual({
      "1": "Maria",
      "2": "segunda-feira, 26/10",
      "3": "14:00",
      "4": "Avaliação",
      "5": "Dra. Ana",
      "6": "Av. Brasil, 100 — sala 3",
    });
    // O que o paciente lê — a mesma função que a cadeia de envio usa para o corpo.
    const componentes = [
      {
        type: "BODY",
        text: "Olá {{1}}! Seu horário: {{4}}, {{2}} às {{3}}, com {{5}}. Local: {{6}}.",
      },
    ];
    expect(
      renderTemplateBody(componentes, r.values, {
        name: "lembrete_consulta",
        language: "pt_BR",
        parameterFormat: "POSITIONAL",
      }),
    ).toBe(
      "Olá Maria! Seu horário: Avaliação, segunda-feira, 26/10 às 14:00, com Dra. Ana. Local: Av. Brasil, 100 — sala 3.",
    );
  });

  it("modelo nomeado: chaveia pelo nome da variável", () => {
    const r = montarValores(nomeado, dados);
    expect(r).toEqual({
      ok: true,
      values: {
        nome: "Maria",
        servico: "Avaliação",
        data: "segunda-feira, 26/10",
        hora: "14:00",
        clinica: "Sorriso Perfeito",
      },
    });
  });

  it("quebra de linha, tabulação e espaços demais saem do parâmetro", () => {
    expect(limparParametro("  Av.  Brasil,\n100\t sala     3  ")).toBe("Av. Brasil, 100 sala 3");
    const r = montarValores(posicional, { ...dados, local: "Rua A\n\nRua B" });
    expect(r.ok && r.values["6"]).toBe("Rua A Rua B");
  });

  it("parâmetro gigante é cortado — a Meta recusa texto de parâmetro desmedido", () => {
    expect(limparParametro("x".repeat(500))).toHaveLength(200);
  });
});

describe("modelos que o lembrete recusa", () => {
  it("variável desconhecida no corpo", () => {
    const c = deriveTemplateContract({
      name: "m",
      language: "pt_BR",
      parameter_format: "NAMED",
      components: [{ type: "BODY", text: "Olá {{nome}}, seu plano {{plano}}." }],
    });
    expect(problemasDoModelo(c)).toEqual([{ slot: "plano", porque: "campo_desconhecido" }]);
    const r = montarValores(c, dados);
    expect(r.ok).toBe(false);
  });

  it("posicional além do sexto slot", () => {
    const c = deriveTemplateContract({
      name: "m",
      language: "pt_BR",
      components: [{ type: "BODY", text: "{{1}} {{2}} {{3}} {{4}} {{5}} {{6}} {{7}}" }],
    });
    expect(problemasDoModelo(c)).toEqual([{ slot: "7", porque: "campo_desconhecido" }]);
  });

  it("variável no cabeçalho", () => {
    const c = deriveTemplateContract({
      name: "m",
      language: "pt_BR",
      parameter_format: "NAMED",
      components: [
        { type: "HEADER", format: "TEXT", text: "Olá {{nome}}" },
        { type: "BODY", text: "Seu horário é {{hora}}." },
      ],
    });
    expect(problemasDoModelo(c)).toEqual([{ slot: "header:nome", porque: "fora_do_corpo" }]);
  });

  it("botão de URL com variável", () => {
    const c = deriveTemplateContract({
      name: "m",
      language: "pt_BR",
      components: [
        { type: "BODY", text: "Olá {{1}}." },
        { type: "BUTTONS", buttons: [{ type: "URL", text: "Ver", url: "https://x.com/{{1}}" }] },
      ],
    });
    const problemas = problemasDoModelo(c);
    expect(problemas).toHaveLength(1);
    expect(problemas[0]?.porque).toBe("fora_do_corpo");
  });

  it("cabeçalho de mídia (imagem) também recusa — o lembrete não tem o que mandar", () => {
    const c = deriveTemplateContract({
      name: "m",
      language: "pt_BR",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Olá {{1}}." },
      ],
    });
    expect(problemasDoModelo(c).some((p) => p.porque === "fora_do_corpo")).toBe(true);
  });

  it("modelo sem variável nenhuma serve (ex.: aviso fixo com botões)", () => {
    const c = deriveTemplateContract({
      name: "m",
      language: "pt_BR",
      components: [{ type: "BODY", text: "Sua consulta é amanhã." }, botoes],
    });
    expect(problemasDoModelo(c)).toEqual([]);
    expect(montarValores(c, dados)).toEqual({ ok: true, values: {} });
  });
});
