import { describe, expect, it, vi } from "vitest";

import type { RelatoLido } from "@/lib/agenda/secretaria/relato";
import type { ResultadoDaConferencia } from "@/lib/agenda/secretaria/relatos";
import {
  executarTurnoDaSecretaria,
  VALIDADE_DO_RESUMO_HORAS,
  type Portas,
} from "@/lib/bastidor/secretaria/turno";

/**
 * O ROTEIRO DA CONVERSA COM A SECRETARIA, com portas de mentira. O que se prova aqui, acima de tudo:
 * a agenda só muda com o "sim" inequívoco, dúvida nunca vira gravação, e resumo velho não vale.
 */
const FUSO = "America/Sao_Paulo";
const AGORA = new Date("2026-11-17T15:00:00Z"); // terça 12h em Brasília

const LIDO: RelatoLido = {
  janela: { de: "2026-11-18", ate: "2026-11-18" },
  marcados: [{ nome: "Maria", inicio: "2026-11-18T17:00:00.000Z" }],
  dias_fechados: [],
  duvidas: [],
};

const RESPOSTA_DO_MODELO = JSON.stringify({
  tipo: "relato",
  janela: { de: "2026-11-18", ate: "2026-11-18" },
  marcados: [{ nome: "Maria", inicio: "2026-11-18T14:00" }],
  dias_fechados: [],
  duvidas: [],
});

const CONFERIDO: ResultadoDaConferencia = {
  relatoId: "r1",
  jaConferido: false,
  criados: 1,
  mantidos: 0,
  cancelados: 0,
  diasFechados: 0,
  diasReabertos: 0,
};

function portas(over: Partial<Portas> = {}) {
  const enviados: string[] = [];
  const p = {
    agora: AGORA,
    fuso: FUSO,
    texto: "terça 14h Maria",
    pendente: null,
    jaRegistrado: null,
    lerComModelo: vi.fn(async () => RESPOSTA_DO_MODELO),
    registrar: vi.fn(async () => ({ id: "novo", duplicado: false })),
    conferir: vi.fn(async () => CONFERIDO),
    marcarCorrigido: vi.fn(async () => undefined),
    descartar: vi.fn(async () => undefined),
    enviar: vi.fn(async (t: string) => {
      enviados.push(t);
    }),
    ...over,
  } satisfies Portas;
  return { p, enviados };
}

const pendente = (criadoEm = new Date(AGORA.getTime() - 10 * 60_000)) => ({ id: "pend", lido: LIDO, criadoEm });

describe("relato novo (nada esperando conferência)", () => {
  it("lê, REGISTRA e devolve o resumo para ela conferir — sem tocar a agenda", async () => {
    const { p, enviados } = portas();
    const r = await executarTurnoDaSecretaria(p);
    expect(r).toEqual({ acao: "resumo_enviado", relatoId: "novo", corrigiu: false, replay: false });
    expect(p.registrar).toHaveBeenCalledTimes(1);
    expect(p.conferir).not.toHaveBeenCalled(); // a agenda só muda no "sim"
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toContain("Entendi assim:");
    expect(enviados[0]).toContain("14h Maria");
    expect(enviados[0]).toContain("Está certo?");
  });

  it("guarda o texto bruto que ela escreveu junto com o que foi entendido", async () => {
    const { p } = portas({ texto: "terça 14h Maria\ne depois nada" });
    await executarTurnoDaSecretaria(p);
    expect(p.registrar).toHaveBeenCalledWith(expect.objectContaining({ janela: LIDO.janela }), "terça 14h Maria\ne depois nada");
  });

  it("o prompt leva o texto dela e o relógio do servidor", async () => {
    const { p } = portas();
    await executarTurnoDaSecretaria(p);
    const prompt = (p.lerComModelo as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(prompt).toContain("terça 14h Maria");
    expect(prompt).toContain("2026-11-17");
  });
});

describe("o 'sim' — o único que mexe na agenda", () => {
  it("com um resumo esperando: aplica e confirma, e NÃO chama o modelo", async () => {
    const { p, enviados } = portas({ texto: "sim", pendente: pendente() });
    const r = await executarTurnoDaSecretaria(p);
    expect(r).toEqual({ acao: "agenda_conferida", resultado: CONFERIDO });
    expect(p.conferir).toHaveBeenCalledWith("pend");
    expect(p.lerComModelo).not.toHaveBeenCalled();
    expect(p.registrar).not.toHaveBeenCalled();
    expect(enviados[0]).toContain("agenda atualizada");
    expect(enviados[0]).toContain("1 horário anotado");
  });

  it.each(["Sim!", "isso mesmo", "ok", "👍", "certo, obrigada"])("'%s' confirma", async (texto) => {
    const { p } = portas({ texto, pendente: pendente() });
    expect((await executarTurnoDaSecretaria(p)).acao).toBe("agenda_conferida");
  });

  it("'sim, mas…' NÃO confirma: é correção, e vira um resumo novo para conferir", async () => {
    const { p, enviados } = portas({ texto: "sim, mas a Maria é às 15h", pendente: pendente() });
    const r = await executarTurnoDaSecretaria(p);
    expect(p.conferir).not.toHaveBeenCalled();
    expect(r).toMatchObject({ acao: "resumo_enviado", corrigiu: true });
    expect(enviados[0]).toContain("Entendi assim:");
  });

  it("'sim' SEM nada esperando: não grava nada e diz que não há o que conferir", async () => {
    const { p, enviados } = portas({ texto: "sim", pendente: null });
    const r = await executarTurnoDaSecretaria(p);
    expect(r).toEqual({ acao: "perguntou", motivo: "sem_nada_para_conferir" });
    expect(p.conferir).not.toHaveBeenCalled();
    expect(p.lerComModelo).not.toHaveBeenCalled();
    expect(enviados[0]).toMatch(/nenhuma agenda esperando/i);
  });

  it("o resumo está VELHO (mais de 12h): descarta e trata o 'sim' como sem nada esperando", async () => {
    const velho = pendente(new Date(AGORA.getTime() - (VALIDADE_DO_RESUMO_HORAS + 1) * 3_600_000));
    const { p } = portas({ texto: "sim", pendente: velho });
    const r = await executarTurnoDaSecretaria(p);
    expect(p.descartar).toHaveBeenCalledWith("pend");
    expect(p.conferir).not.toHaveBeenCalled();
    expect(r).toEqual({ acao: "perguntou", motivo: "sem_nada_para_conferir" });
  });

  it("o resumo está no limite (12h): ainda vale", async () => {
    const limite = pendente(new Date(AGORA.getTime() - VALIDADE_DO_RESUMO_HORAS * 3_600_000));
    const { p } = portas({ texto: "sim", pendente: limite });
    expect((await executarTurnoDaSecretaria(p)).acao).toBe("agenda_conferida");
  });

  it("dono da agenda não configurado: avisa o que falta, em vez de falhar calada", async () => {
    const { p, enviados } = portas({
      texto: "sim",
      pendente: pendente(),
      conferir: vi.fn(async () => {
        throw new Error("dono_da_agenda_nao_definido");
      }),
    });
    expect(await executarTurnoDaSecretaria(p)).toEqual({ acao: "falta_configurar" });
    expect(enviados[0]).toMatch(/falta uma configuração/i);
  });

  it("outro erro ao aplicar PROPAGA (o job tenta de novo) e nada é enviado", async () => {
    const { p, enviados } = portas({
      texto: "sim",
      pendente: pendente(),
      conferir: vi.fn(async () => {
        throw new Error("banco fora do ar");
      }),
    });
    await expect(executarTurnoDaSecretaria(p)).rejects.toThrow("banco fora do ar");
    expect(enviados).toEqual([]);
  });
});

describe("o 'não' e a correção", () => {
  it("'não' seco: pergunta o que corrigir e o resumo continua esperando (nada é marcado)", async () => {
    const { p, enviados } = portas({ texto: "não", pendente: pendente() });
    expect(await executarTurnoDaSecretaria(p)).toEqual({ acao: "perguntou", motivo: "nao" });
    expect(p.marcarCorrigido).not.toHaveBeenCalled();
    expect(p.conferir).not.toHaveBeenCalled();
    expect(enviados[0]).toMatch(/O que está diferente/);
  });

  it("correção: registra o novo e SÓ DEPOIS marca o antigo como corrigido", async () => {
    const ordem: string[] = [];
    const { p } = portas({
      texto: "a Maria é às 15h",
      pendente: pendente(),
      registrar: vi.fn(async () => {
        ordem.push("registrar");
        return { id: "novo", duplicado: false };
      }),
      marcarCorrigido: vi.fn(async () => {
        ordem.push("corrigir");
      }),
    });
    const r = await executarTurnoDaSecretaria(p);
    expect(ordem).toEqual(["registrar", "corrigir"]);
    expect(p.marcarCorrigido).toHaveBeenCalledWith("pend");
    expect(r).toMatchObject({ acao: "resumo_enviado", corrigiu: true });
  });

  it("se registrar a correção FALHA, o resumo antigo não é marcado (nada mudou)", async () => {
    const { p } = portas({
      texto: "a Maria é às 15h",
      pendente: pendente(),
      registrar: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(executarTurnoDaSecretaria(p)).rejects.toThrow("boom");
    expect(p.marcarCorrigido).not.toHaveBeenCalled();
  });

  it("a correção vai ao modelo COM o resumo anterior", async () => {
    const { p } = portas({ texto: "a Maria é às 15h", pendente: pendente() });
    await executarTurnoDaSecretaria(p);
    const prompt = (p.lerComModelo as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(prompt).toContain("RESUMO QUE VOCÊ MANDOU ANTES");
    expect(prompt).toContain("2026-11-18T14:00");
  });
});

describe("dúvida nunca vira gravação", () => {
  const duvida = JSON.stringify({
    tipo: "relato",
    janela: { de: "2026-11-18", ate: "2026-11-18" },
    marcados: [],
    dias_fechados: [],
    duvidas: ["A Ana é de manhã ou de tarde?"],
  });

  it("o modelo achou ambiguidade: pergunta, não registra, não confere", async () => {
    const { p, enviados } = portas({ texto: "a Ana vem amanhã", lerComModelo: vi.fn(async () => duvida) });
    expect(await executarTurnoDaSecretaria(p)).toEqual({ acao: "perguntou", motivo: "duvida" });
    expect(p.registrar).not.toHaveBeenCalled();
    expect(p.conferir).not.toHaveBeenCalled();
    expect(enviados[0]).toContain("A Ana é de manhã ou de tarde?");
  });

  it("dúvida durante uma correção: o resumo antigo continua esperando", async () => {
    const { p } = portas({ texto: "a Ana vem amanhã", pendente: pendente(), lerComModelo: vi.fn(async () => duvida) });
    await executarTurnoDaSecretaria(p);
    expect(p.marcarCorrigido).not.toHaveBeenCalled();
  });

  it("saída ilegível do modelo: pede de novo, não grava", async () => {
    const { p, enviados } = portas({ lerComModelo: vi.fn(async () => "desculpe, não entendi") });
    expect(await executarTurnoDaSecretaria(p)).toEqual({ acao: "perguntou", motivo: "ilegivel" });
    expect(p.registrar).not.toHaveBeenCalled();
    expect(enviados[0]).toMatch(/dia por dia/);
  });

  it("falha do MODELO propaga (o job tenta de novo) e nada é enviado", async () => {
    const { p, enviados } = portas({
      lerComModelo: vi.fn(async () => {
        throw new Error("provedor fora");
      }),
    });
    await expect(executarTurnoDaSecretaria(p)).rejects.toThrow("provedor fora");
    expect(enviados).toEqual([]);
    expect(p.registrar).not.toHaveBeenCalled();
  });
});

describe("outros casos", () => {
  it("conversa fora do assunto: responde curto e não grava", async () => {
    const { p, enviados } = portas({
      texto: "bom dia!",
      lerComModelo: vi.fn(async () => JSON.stringify({ tipo: "outro" })),
    });
    expect(await executarTurnoDaSecretaria(p)).toEqual({ acao: "outro_assunto" });
    expect(p.registrar).not.toHaveBeenCalled();
    expect(enviados[0]).toMatch(/cuido da agenda/);
  });

  it("sem texto nenhum (mídia sem transcrição): pede que escreva, sem chamar o modelo", async () => {
    const { p, enviados } = portas({ texto: "   " });
    expect(await executarTurnoDaSecretaria(p)).toEqual({ acao: "perguntou", motivo: "sem_texto" });
    expect(p.lerComModelo).not.toHaveBeenCalled();
    expect(enviados[0]).toMatch(/escrever a agenda em texto/);
  });

  it("REPLAY: esta mesma mensagem já gerou um resumo — reenvia o mesmo, sem reler nem registrar de novo", async () => {
    const { p, enviados } = portas({ jaRegistrado: { id: "ja", estado: "lido", lido: LIDO } });
    expect(await executarTurnoDaSecretaria(p)).toEqual({ acao: "resumo_enviado", relatoId: "ja", corrigiu: false, replay: true });
    expect(p.lerComModelo).not.toHaveBeenCalled();
    expect(p.registrar).not.toHaveBeenCalled();
    expect(enviados[0]).toContain("14h Maria");
  });

  it("REPLAY de um relato que JÁ foi conferido: não reenvia o resumo (o 'sim' já aconteceu)", async () => {
    const { p } = portas({ texto: "terça 14h Maria", jaRegistrado: { id: "ja", estado: "conferido", lido: LIDO } });
    const r = await executarTurnoDaSecretaria(p);
    // Cai no fluxo normal: lê de novo e registra (a unicidade por mensagem devolve o mesmo id, duplicado).
    expect(r.acao).toBe("resumo_enviado");
  });

  it("registro duplicado (a mesma mensagem processada por outro job): reenvia o resumo marcado como replay", async () => {
    const { p } = portas({ registrar: vi.fn(async () => ({ id: "x", duplicado: true })) });
    expect(await executarTurnoDaSecretaria(p)).toMatchObject({ acao: "resumo_enviado", replay: true });
  });

  it("manda UMA mensagem por turno, em qualquer caminho", async () => {
    for (const texto of ["sim", "não", "terça 14h Maria", "bom dia", "   "]) {
      const { p, enviados } = portas({ texto, pendente: pendente() });
      await executarTurnoDaSecretaria(p);
      expect(enviados.length, texto).toBe(1);
    }
  });
});
