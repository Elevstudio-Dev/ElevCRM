import { describe, expect, it, vi } from "vitest";

import { CONFIG_PADRAO_DA_SECRETARIA } from "@/lib/agenda/secretaria/config";
import type { PerguntaFeita } from "@/lib/bastidor/secretaria/perguntas";
import {
  executarTickDasPerguntas,
  type PortasDaSecretaria,
  type PortasDoTick,
  type SecretariaAtiva,
} from "@/lib/bastidor/secretaria/perguntas-tick";

/**
 * O TICK das perguntas, com portas de mentira. O que se prova aqui é a ORDEM e o isolamento: gravar antes de
 * enfileirar (para duas instâncias não perguntarem em dobro), resposta detectada antes de lembrar, e uma secretaria
 * que quebra não derrubar a outra.
 */
const sp = (dia: string, hhmm: string): Date => new Date(`${dia}T${hhmm}:00-03:00`);
const TERCA = "2026-11-17";
const CONVERSA = { conversationId: "conv-1", channelSessionId: "sess-1" };

const SEC = (id: string): SecretariaAtiva => ({
  organizationId: `org-${id}`,
  contactId: `contato-${id}`,
  nome: `Secretaria ${id}`,
  config: { ...CONFIG_PADRAO_DA_SECRETARIA, ativa: true },
  fuso: "America/Sao_Paulo",
});

function portasFalsas(over: Partial<PortasDaSecretaria> = {}) {
  const chamadas: string[] = [];
  const registro = (nome: string) => (...a: unknown[]) => {
    chamadas.push(`${nome}:${a.filter((x) => typeof x === "string").join("/")}`);
  };
  const portas: PortasDaSecretaria = {
    feitasHoje: vi.fn(async () => []),
    ultimaConferidaEm: vi.fn(async () => null),
    primeiraRespostaDesde: vi.fn(async () => null),
    registrar: vi.fn(async (...a) => (registro("registrar")(...a), true)),
    marcarRespondida: vi.fn(async (...a) => registro("respondida")(...a)),
    marcarLembrete: vi.fn(async (...a) => (registro("lembrete")(...a), true)),
    marcarAdminAvisado: vi.fn(async (...a) => (registro("admin_avisado")(...a), true)),
    conversa: vi.fn(async () => CONVERSA),
    enfileirar: vi.fn(async (p) => registro("enfileirar")(p.acao, p.dia, p.horario)),
    avisarAdmin: vi.fn(async (...a) => registro("aviso")(...a)),
    resumoPendente: vi.fn(async () => null),
    enfileirarLembreteDaConferencia: vi.fn(async (relatoId: string) => (registro("lembrete_conferencia")(relatoId), true)),
    lembreteDaConferenciaEnviadoEm: vi.fn(async () => null),
    fecharAvisosDeResumoResolvidos: vi.fn(async () => 0),
    avisarResumoSemConfirmacao: vi.fn(async (relatoId: string) => (registro("aviso_resumo")(relatoId), true)),
    ...over,
  };
  return { portas, chamadas };
}

function tick(agora: Date, porSecretaria: Record<string, PortasDaSecretaria>, secretarias: SecretariaAtiva[]) {
  const erros: string[] = [];
  const p: PortasDoTick = {
    agora: () => agora,
    listarSecretarias: async () => secretarias,
    portasDe: (s) => porSecretaria[s.contactId]!,
    registrarErro: (contexto) => erros.push(contexto),
  };
  return { rodar: () => executarTickDasPerguntas(p), erros };
}

const pedida = (horario: string, pedida: string, extra: Partial<PerguntaFeita> = {}): PerguntaFeita => ({
  dia: TERCA,
  horario,
  estado: "pedida",
  pedidaEm: sp(TERCA, pedida),
  lembretePedidoEm: null,
  respondidaEm: null,
  adminAvisadoEm: null,
  ...extra,
});

describe("perguntar", () => {
  it("grava a linha ANTES de enfileirar, e enfileira com a conversa dela", async () => {
    const { portas, chamadas } = portasFalsas();
    const r = await tick(sp(TERCA, "08:30"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(chamadas).toEqual([`registrar:${TERCA}/08:30/pedida`, `enfileirar:perguntar/${TERCA}/08:30`]);
    expect(portas.enfileirar).toHaveBeenCalledWith({ acao: "perguntar", dia: TERCA, horario: "08:30", conversa: CONVERSA });
    expect(r).toMatchObject({ secretarias: 1, perguntadas: 1, erros: 0 });
  });

  it("outra instância gravou primeiro (registrar devolve falso): NÃO enfileira — a pergunta não sai em dobro", async () => {
    const { portas } = portasFalsas({ registrar: vi.fn(async () => false) });
    const r = await tick(sp(TERCA, "08:30"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.enfileirar).not.toHaveBeenCalled();
    expect(r.perguntadas).toBe(0);
  });

  it("sem conversa com ela: grava 'sem_conversa', avisa o administrador UMA vez e não enfileira", async () => {
    const { portas } = portasFalsas({ conversa: vi.fn(async () => null) });
    const r = await tick(sp(TERCA, "08:30"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.registrar).toHaveBeenCalledWith(TERCA, "08:30", "sem_conversa");
    expect(portas.avisarAdmin).toHaveBeenCalledWith("sem_conversa", TERCA, "08:30");
    expect(portas.enfileirar).not.toHaveBeenCalled();
    expect(r).toMatchObject({ perguntadas: 0, avisos: 1 });
  });

  it("agenda conferida há pouco: grava 'dispensada' e não pergunta", async () => {
    const { portas } = portasFalsas({ ultimaConferidaEm: vi.fn(async () => sp(TERCA, "08:00")) });
    const r = await tick(sp(TERCA, "08:30"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.registrar).toHaveBeenCalledWith(TERCA, "08:30", "dispensada");
    expect(portas.enfileirar).not.toHaveBeenCalled();
    expect(r).toMatchObject({ dispensadas: 1, perguntadas: 0 });
  });

  it("fora do horário: não consulta conversa nem grava nada", async () => {
    const { portas } = portasFalsas();
    await tick(sp(TERCA, "07:00"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.conversa).not.toHaveBeenCalled();
    expect(portas.registrar).not.toHaveBeenCalled();
  });
});

describe("a resposta dela", () => {
  it("respondeu depois da pergunta: marca respondida e NÃO lembra", async () => {
    const { portas } = portasFalsas({
      feitasHoje: vi.fn(async () => [pedida("08:30", "08:30")]),
      primeiraRespostaDesde: vi.fn(async () => sp(TERCA, "08:45")),
    });
    const r = await tick(sp(TERCA, "09:05"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.marcarRespondida).toHaveBeenCalledWith(TERCA, "08:30", sp(TERCA, "08:45"));
    expect(portas.marcarLembrete).not.toHaveBeenCalled();
    expect(portas.enfileirar).not.toHaveBeenCalled();
    expect(r).toMatchObject({ respondidas: 1, lembradas: 0 });
  });

  it("não olha a resposta de pergunta já respondida ou resolvida", async () => {
    const { portas } = portasFalsas({
      feitasHoje: vi.fn(async () => [
        pedida("08:30", "08:30", { respondidaEm: sp(TERCA, "08:40") }),
        pedida("14:00", "14:00", { estado: "dispensada" }),
      ]),
    });
    await tick(sp(TERCA, "14:10"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.primeiraRespostaDesde).not.toHaveBeenCalled();
  });
});

describe("lembrar e avisar", () => {
  it("30 min sem resposta: carimba o lembrete e enfileira 'lembrar'", async () => {
    const { portas, chamadas } = portasFalsas({ feitasHoje: vi.fn(async () => [pedida("08:30", "08:30")]) });
    const r = await tick(sp(TERCA, "09:00"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(chamadas).toEqual([`lembrete:${TERCA}/08:30`, `enfileirar:lembrar/${TERCA}/08:30`]);
    expect(r.lembradas).toBe(1);
  });

  it("outra instância carimbou o lembrete primeiro: não enfileira", async () => {
    const { portas } = portasFalsas({
      feitasHoje: vi.fn(async () => [pedida("08:30", "08:30")]),
      marcarLembrete: vi.fn(async () => false),
    });
    const r = await tick(sp(TERCA, "09:00"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.enfileirar).not.toHaveBeenCalled();
    expect(r.lembradas).toBe(0);
  });

  it("30 min depois do lembrete: carimba e avisa o administrador (motivo sem_resposta)", async () => {
    const { portas, chamadas } = portasFalsas({
      feitasHoje: vi.fn(async () => [pedida("08:30", "08:30", { lembretePedidoEm: sp(TERCA, "09:00") })]),
    });
    const r = await tick(sp(TERCA, "09:30"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(chamadas).toEqual([`admin_avisado:${TERCA}/08:30`, `aviso:sem_resposta/${TERCA}/08:30`]);
    expect(r.avisos).toBe(1);
  });

  it("outra instância já carimbou o aviso: não avisa de novo", async () => {
    const { portas } = portasFalsas({
      feitasHoje: vi.fn(async () => [pedida("08:30", "08:30", { lembretePedidoEm: sp(TERCA, "09:00") })]),
      marcarAdminAvisado: vi.fn(async () => false),
    });
    await tick(sp(TERCA, "09:30"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.avisarAdmin).not.toHaveBeenCalled();
  });
});

describe("isolamento", () => {
  it("uma secretaria que quebra NÃO derruba a outra do mesmo tick", async () => {
    const quebrada = portasFalsas({ feitasHoje: vi.fn(async () => { throw new Error("banco caiu"); }) }).portas;
    const boa = portasFalsas().portas;
    const { rodar, erros } = tick(sp(TERCA, "08:30"), { "contato-a": quebrada, "contato-b": boa }, [SEC("a"), SEC("b")]);
    const r = await rodar();
    expect(boa.enfileirar).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ secretarias: 2, perguntadas: 1, erros: 1 });
    expect(erros).toEqual(["secretaria"]);
  });

  it("uma AÇÃO que quebra (fila fora) é contada e não impede as demais do mesmo tick", async () => {
    const { portas } = portasFalsas({
      feitasHoje: vi.fn(async () => [pedida("08:30", "08:30", { respondidaEm: sp(TERCA, "08:40") })]),
      enfileirar: vi.fn(async () => { throw new Error("fila fora"); }),
    });
    // 14:00 → pergunta nova; a fila falha. Fica registrada (o ciclo do lembrete reenvia), e o tick não explode.
    const { rodar, erros } = tick(sp(TERCA, "14:00"), { "contato-a": portas }, [SEC("a")]);
    const r = await rodar();
    expect(portas.registrar).toHaveBeenCalledWith(TERCA, "14:00", "pedida");
    expect(r.erros).toBe(1);
    expect(erros).toEqual(["perguntar 14:00"]);
  });

  it("sem nenhuma secretaria ativa: tick vazio", async () => {
    const r = await tick(sp(TERCA, "08:30"), {}, []).rodar();
    expect(r).toEqual({
      secretarias: 0,
      perguntadas: 0,
      dispensadas: 0,
      lembradas: 0,
      conferenciasLembradas: 0,
      avisos: 0,
      avisosFechados: 0,
      respondidas: 0,
      erros: 0,
    });
  });
});

describe("com um RESUMO esperando o 'sim' (relato `lido` com menos de 12 h)", () => {
  // O caso de produção: o resumo saiu, ela respondeu (o job falhou ou ainda não rodou) e o cron mandou "Antes de
  // encerrar o dia: como ficou a agenda…" e "Só relembrando…" POR CIMA. A pergunta nova faz a conversa andar para
  // trás: ela já contou a agenda, só falta confirmar.
  const RESUMO = { relatoId: "relato-1", criadoEm: sp(TERCA, "17:50") };

  it("na hora de uma pergunta: NÃO pergunta (grava 'dispensada') e manda UM lembrete de confirmar o resumo", async () => {
    const { portas, chamadas } = portasFalsas({ resumoPendente: vi.fn(async () => RESUMO) });
    const r = await tick(sp(TERCA, "18:15"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(chamadas).toEqual([`registrar:${TERCA}/18:15/dispensada`, "lembrete_conferencia:relato-1"]);
    expect(portas.enfileirar).not.toHaveBeenCalled();
    expect(portas.enfileirarLembreteDaConferencia).toHaveBeenCalledWith("relato-1", CONVERSA);
    expect(r).toMatchObject({ perguntadas: 0, dispensadas: 1, conferenciasLembradas: 1 });
  });

  it("no máximo UM lembrete por resumo: se ele já foi enfileirado (a fila recusa a repetição), não conta de novo", async () => {
    const { portas } = portasFalsas({
      resumoPendente: vi.fn(async () => RESUMO),
      enfileirarLembreteDaConferencia: vi.fn(async () => false),
    });
    const r = await tick(sp(TERCA, "18:15"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.enfileirar).not.toHaveBeenCalled();
    expect(r).toMatchObject({ perguntadas: 0, conferenciasLembradas: 0 });
  });

  it("na hora do LEMBRETE de uma pergunta feita por cima do resumo (antes deste conserto): não manda o 'Só relembrando…'; manda o de confirmar", async () => {
    const { portas } = portasFalsas({
      resumoPendente: vi.fn(async () => ({ relatoId: "relato-1", criadoEm: sp(TERCA, "13:50") })),
      feitasHoje: vi.fn(async () => [pedida("14:00", "14:00")]),
    });
    const r = await tick(sp(TERCA, "14:30"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.marcarLembrete).not.toHaveBeenCalled();
    expect(portas.enfileirar).not.toHaveBeenCalled();
    expect(portas.enfileirarLembreteDaConferencia).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ lembradas: 0, conferenciasLembradas: 1 });
  });

  it("fora da hora de uma pergunta: não manda nada (o lembrete do resumo só ocupa o lugar de uma mensagem que sairia)", async () => {
    const { portas } = portasFalsas({ resumoPendente: vi.fn(async () => RESUMO) });
    await tick(sp(TERCA, "17:55"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.enfileirarLembreteDaConferencia).not.toHaveBeenCalled();
    expect(portas.enfileirar).not.toHaveBeenCalled();
  });

  it("o resumo tem mais de 12 h (venceu): as perguntas voltam ao normal", async () => {
    const { portas } = portasFalsas({
      resumoPendente: vi.fn(async () => ({ relatoId: "velho", criadoEm: sp("2026-11-16", "18:00") })),
    });
    const r = await tick(sp(TERCA, "08:30"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.enfileirar).toHaveBeenCalledWith({ acao: "perguntar", dia: TERCA, horario: "08:30", conversa: CONVERSA });
    expect(portas.enfileirarLembreteDaConferencia).not.toHaveBeenCalled();
    expect(r).toMatchObject({ perguntadas: 1, conferenciasLembradas: 0 });
  });

  describe("o resumo segue sem confirmação depois do lembrete (M2)", () => {
    const resumo = { relatoId: "relato-1", criadoEm: sp(TERCA, "13:50") };

    it("2 h depois do lembrete, ainda lido e dentro das 12 h: abre UM aviso na Central (a IA está sem horários)", async () => {
      const { portas, chamadas } = portasFalsas({
        resumoPendente: vi.fn(async () => resumo),
        lembreteDaConferenciaEnviadoEm: vi.fn(async () => sp(TERCA, "14:00")),
      });
      const r = await tick(sp(TERCA, "16:00"), { "contato-a": portas }, [SEC("a")]).rodar();
      expect(chamadas).toContain("aviso_resumo:relato-1");
      expect(r.avisos).toBe(1);
    });

    it("ela ESCREVEU depois do resumo (ex.: o 'sim' cujo turno falhou): não abre aviso falso de 'não respondeu'", async () => {
      const { portas } = portasFalsas({
        resumoPendente: vi.fn(async () => resumo),
        lembreteDaConferenciaEnviadoEm: vi.fn(async () => sp(TERCA, "14:00")),
        primeiraRespostaDesde: vi.fn(async (desde: Date) => (desde.getTime() === resumo.criadoEm.getTime() ? sp(TERCA, "13:58") : null)),
      });
      const r = await tick(sp(TERCA, "16:00"), { "contato-a": portas }, [SEC("a")]).rodar();
      expect(portas.avisarResumoSemConfirmacao).not.toHaveBeenCalled();
      expect(r.avisos).toBe(0);
    });

    it("todo tick fecha os avisos de resumo que já não espera o 'sim' (com a validade de 12 h), e conta", async () => {
      const { portas } = portasFalsas({ fecharAvisosDeResumoResolvidos: vi.fn(async () => 2) });
      const r = await tick(sp(TERCA, "07:00"), { "contato-a": portas }, [SEC("a")]).rodar();
      expect(portas.fecharAvisosDeResumoResolvidos).toHaveBeenCalledWith(sp(TERCA, "07:00"), 12);
      expect(r.avisosFechados).toBe(2);
    });

    it("1h59 depois: ainda não avisa", async () => {
      const { portas } = portasFalsas({
        resumoPendente: vi.fn(async () => resumo),
        lembreteDaConferenciaEnviadoEm: vi.fn(async () => sp(TERCA, "14:01")),
      });
      await tick(sp(TERCA, "16:00"), { "contato-a": portas }, [SEC("a")]).rodar();
      expect(portas.avisarResumoSemConfirmacao).not.toHaveBeenCalled();
    });

    it("o lembrete ainda não saiu: não avisa", async () => {
      const { portas } = portasFalsas({ resumoPendente: vi.fn(async () => resumo) });
      await tick(sp(TERCA, "20:00"), { "contato-a": portas }, [SEC("a")]).rodar();
      expect(portas.avisarResumoSemConfirmacao).not.toHaveBeenCalled();
    });

    it("já avisado para este resumo (a porta devolve falso): não conta de novo", async () => {
      const { portas } = portasFalsas({
        resumoPendente: vi.fn(async () => resumo),
        lembreteDaConferenciaEnviadoEm: vi.fn(async () => sp(TERCA, "14:00")),
        avisarResumoSemConfirmacao: vi.fn(async () => false),
      });
      expect((await tick(sp(TERCA, "16:30"), { "contato-a": portas }, [SEC("a")]).rodar()).avisos).toBe(0);
    });

    it("o resumo venceu (12 h): não avisa (o caminho passa a ser a pergunta diária de novo)", async () => {
      const { portas } = portasFalsas({
        resumoPendente: vi.fn(async () => ({ relatoId: "velho", criadoEm: sp("2026-11-16", "18:00") })),
        lembreteDaConferenciaEnviadoEm: vi.fn(async () => sp("2026-11-16", "18:15")),
      });
      await tick(sp(TERCA, "16:00"), { "contato-a": portas }, [SEC("a")]).rodar();
      expect(portas.avisarResumoSemConfirmacao).not.toHaveBeenCalled();
    });
  });

  it("o aviso ao administrador segue valendo (ele não fala com a secretaria)", async () => {
    const { portas } = portasFalsas({
      resumoPendente: vi.fn(async () => ({ relatoId: "relato-1", criadoEm: sp(TERCA, "08:00") })),
      feitasHoje: vi.fn(async () => [pedida("08:30", "08:30", { lembretePedidoEm: sp(TERCA, "09:00") })]),
    });
    const r = await tick(sp(TERCA, "09:30"), { "contato-a": portas }, [SEC("a")]).rodar();
    expect(portas.avisarAdmin).toHaveBeenCalledWith("sem_resposta", TERCA, "08:30");
    expect(r.avisos).toBe(1);
  });
});
