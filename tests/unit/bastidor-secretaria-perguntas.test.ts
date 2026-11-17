import { describe, expect, it } from "vitest";

import { CONFIG_PADRAO_DA_SECRETARIA, type ConfigDaSecretaria } from "@/lib/agenda/secretaria/config";
import {
  planejarPerguntas,
  type AcaoDaPergunta,
  type PerguntaFeita,
} from "@/lib/bastidor/secretaria/perguntas";
import { TEXTO_DO_LEMBRETE_DA_PERGUNTA, textoDaPergunta } from "@/lib/bastidor/secretaria/textos";

/**
 * QUANDO perguntar, lembrar e avisar o administrador. Regra pura, relógio injetado.
 *
 * O fuso é o de São Paulo (UTC-3, sem horário de verão desde 2019): 08:30 de lá é 11:30Z. 2026-11-17 é terça-feira.
 */
const FUSO = "America/Sao_Paulo";
const CONFIG: ConfigDaSecretaria = { ...CONFIG_PADRAO_DA_SECRETARIA, ativa: true };

/** Hora de parede de São Paulo → instante (UTC-3 fixo). */
const sp = (dia: string, hhmm: string): Date => new Date(`${dia}T${hhmm}:00-03:00`);

const TERCA = "2026-11-17";
const SABADO = "2026-11-21";
const DOMINGO = "2026-11-22";

function plano(agora: Date, extra: Partial<Parameters<typeof planejarPerguntas>[0]> = {}): AcaoDaPergunta[] {
  return planejarPerguntas({ config: CONFIG, fuso: FUSO, agora, feitas: [], ultimaConferidaEm: null, ...extra });
}

function feita(horario: string, pedida: string, extra: Partial<PerguntaFeita> = {}): PerguntaFeita {
  return {
    dia: TERCA,
    horario,
    estado: "pedida",
    pedidaEm: sp(TERCA, pedida),
    lembretePedidoEm: null,
    respondidaEm: null,
    adminAvisadoEm: null,
    ...extra,
  };
}

describe("perguntar", () => {
  it("antes do horário não pergunta", () => {
    expect(plano(sp(TERCA, "08:29"))).toEqual([]);
  });

  it("no horário, pergunta", () => {
    expect(plano(sp(TERCA, "08:30"))).toEqual([{ tipo: "perguntar", dia: TERCA, horario: "08:30" }]);
  });

  it("atrasado dentro da tolerância (2 h) ainda pergunta; passou disso, não (cron fora do ar)", () => {
    expect(plano(sp(TERCA, "10:30"))).toEqual([{ tipo: "perguntar", dia: TERCA, horario: "08:30" }]);
    expect(plano(sp(TERCA, "10:31"))).toEqual([]);
  });

  it("não pergunta o que já foi perguntado (a chave única é a idempotência)", () => {
    expect(plano(sp(TERCA, "08:35"), { feitas: [feita("08:30", "08:30")] })).toEqual([]);
  });

  it("cada horário do dia é independente", () => {
    const a = plano(sp(TERCA, "14:00"), { feitas: [feita("08:30", "08:30", { respondidaEm: sp(TERCA, "08:40") })] });
    expect(a).toEqual([{ tipo: "perguntar", dia: TERCA, horario: "14:00" }]);
  });

  it("horário repetido na configuração não vira duas perguntas", () => {
    const config = { ...CONFIG, perguntas: ["08:30", "08:30"] };
    expect(plano(sp(TERCA, "08:30"), { config })).toHaveLength(1);
  });
});

describe("dias e liga/desliga", () => {
  it("sábado e domingo não perguntam (padrão: segunda a sexta)", () => {
    expect(plano(sp(SABADO, "08:30"))).toEqual([]);
    expect(plano(sp(DOMINGO, "08:30"))).toEqual([]);
  });

  it("os dias vêm da configuração: com sábado ligado, pergunta", () => {
    const config = { ...CONFIG, dias: [1, 2, 3, 4, 5, 6] };
    expect(plano(sp(SABADO, "08:30"), { config })).toEqual([{ tipo: "perguntar", dia: SABADO, horario: "08:30" }]);
  });

  it("secretaria desligada (o padrão): nada, nunca", () => {
    const config = { ...CONFIG, ativa: false };
    expect(plano(sp(TERCA, "08:30"), { config })).toEqual([]);
  });

  it("o dia é o do FUSO da agenda, não o do servidor: 02:00Z de quarta ainda é terça à noite em São Paulo", () => {
    // 2026-11-18T02:00Z = terça 17/11, 23:00 em São Paulo — passou da tolerância das 18:15, nada a perguntar.
    expect(plano(new Date("2026-11-18T02:00:00Z"))).toEqual([]);
  });

  it("outro fuso: 08:30 em Manaus (UTC-4) é 12:30Z", () => {
    const a = planejarPerguntas({
      config: CONFIG,
      fuso: "America/Manaus",
      agora: new Date("2026-11-17T12:30:00Z"),
      feitas: [],
      ultimaConferidaEm: null,
    });
    expect(a).toEqual([{ tipo: "perguntar", dia: TERCA, horario: "08:30" }]);
  });
});

describe("dispensar: a agenda acabou de ser conferida", () => {
  it("conferida na hora anterior ao horário: dispensa em vez de repetir a pergunta", () => {
    const a = plano(sp(TERCA, "08:30"), { ultimaConferidaEm: sp(TERCA, "07:45") });
    expect(a).toEqual([{ tipo: "dispensar", dia: TERCA, horario: "08:30" }]);
  });

  it("conferida há mais de uma hora antes do horário: pergunta", () => {
    const a = plano(sp(TERCA, "08:30"), { ultimaConferidaEm: sp(TERCA, "07:00") });
    expect(a).toEqual([{ tipo: "perguntar", dia: TERCA, horario: "08:30" }]);
  });

  it("conferida DEPOIS do horário marcado (mas antes do tick): também dispensa", () => {
    const a = plano(sp(TERCA, "08:40"), { ultimaConferidaEm: sp(TERCA, "08:35") });
    expect(a).toEqual([{ tipo: "dispensar", dia: TERCA, horario: "08:30" }]);
  });

  it("carimbo no futuro (relógio torto) NÃO dispensa", () => {
    const a = plano(sp(TERCA, "08:30"), { ultimaConferidaEm: sp(TERCA, "09:30") });
    expect(a).toEqual([{ tipo: "perguntar", dia: TERCA, horario: "08:30" }]);
  });
});

describe("lembrar, uma vez", () => {
  it("antes de 30 min sem resposta: espera", () => {
    expect(plano(sp(TERCA, "08:59"), { feitas: [feita("08:30", "08:30")] })).toEqual([]);
  });

  it("com 30 min sem resposta: lembra", () => {
    expect(plano(sp(TERCA, "09:00"), { feitas: [feita("08:30", "08:30")] })).toEqual([
      { tipo: "lembrar", dia: TERCA, horario: "08:30" },
    ]);
  });

  it("respondida: não lembra", () => {
    const f = feita("08:30", "08:30", { respondidaEm: sp(TERCA, "08:50") });
    expect(plano(sp(TERCA, "09:30"), { feitas: [f] })).toEqual([]);
  });

  it("já lembrada: não lembra de novo", () => {
    const f = feita("08:30", "08:30", { lembretePedidoEm: sp(TERCA, "09:00") });
    expect(plano(sp(TERCA, "09:10"), { feitas: [f] })).toEqual([]);
  });
});

describe("avisar o administrador, uma vez", () => {
  it("30 min depois do lembrete sem resposta: avisa", () => {
    const f = feita("08:30", "08:30", { lembretePedidoEm: sp(TERCA, "09:00") });
    expect(plano(sp(TERCA, "09:30"), { feitas: [f] })).toEqual([{ tipo: "avisar_admin", dia: TERCA, horario: "08:30" }]);
  });

  it("29 min depois do lembrete: ainda não", () => {
    const f = feita("08:30", "08:30", { lembretePedidoEm: sp(TERCA, "09:00") });
    expect(plano(sp(TERCA, "09:29"), { feitas: [f] })).toEqual([]);
  });

  it("já avisado: não avisa de novo", () => {
    const f = feita("08:30", "08:30", { lembretePedidoEm: sp(TERCA, "09:00"), adminAvisadoEm: sp(TERCA, "09:30") });
    expect(plano(sp(TERCA, "10:30"), { feitas: [f] })).toEqual([]);
  });

  it("respondeu depois do lembrete: não avisa", () => {
    const f = feita("08:30", "08:30", { lembretePedidoEm: sp(TERCA, "09:00"), respondidaEm: sp(TERCA, "09:20") });
    expect(plano(sp(TERCA, "09:40"), { feitas: [f] })).toEqual([]);
  });

  it.each(["dispensada", "sem_conversa"] as const)("pergunta '%s' está resolvida: nada a fazer", (estado) => {
    expect(plano(sp(TERCA, "10:00"), { feitas: [feita("08:30", "08:30", { estado })] })).toEqual([]);
  });
});

describe("os textos fixos", () => {
  it("o cumprimento acompanha o horário da pergunta", () => {
    expect(textoDaPergunta("08:30")).toMatch(/^Bom dia!/);
    expect(textoDaPergunta("14:00")).toMatch(/^Boa tarde!/);
    expect(textoDaPergunta("18:15")).toMatch(/^Antes de encerrar o dia/);
  });

  it("toda pergunta traz um exemplo de como contar a agenda", () => {
    for (const h of ["08:30", "14:00", "18:15"]) expect(textoDaPergunta(h)).toMatch(/Por exemplo:/);
  });

  it("o lembrete não cobra nem ameaça", () => {
    expect(TEXTO_DO_LEMBRETE_DA_PERGUNTA).not.toMatch(/urgente|obrigat|imediat|!!/i);
  });
});
