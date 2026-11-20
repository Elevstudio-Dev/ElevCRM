// @vitest-environment node
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runBeforeSend = vi.fn();
const runModelCall = vi.fn();
const conferirEAplicarRelato = vi.fn();
const registrarRelato = vi.fn();
const marcarRelatoCorrigido = vi.fn();
const descartarRelato = vi.fn();

const reservaEmPerguntaAberta = vi.fn();
const tratarRespostaDaReserva = vi.fn();
const executarTrabalhoDaReserva = vi.fn();
vi.mock("@/lib/agenda/secretaria/reservas", () => ({
  reservaEmPerguntaAberta: (...a: unknown[]) => reservaEmPerguntaAberta(...a),
}));
vi.mock("@/lib/agent-engine/agent/bastidor-reserva", async () => {
  const { z } = await import("zod");
  return {
    // O mesmo contrato do schema real: o trabalho de reserva traz `acao` e `reserva_id`.
    trabalhoDaReservaPayloadSchema: z
      .object({
        conversation_id: z.string().uuid(),
        contact_id: z.string().uuid(),
        channel_session_id: z.string().uuid(),
        acao: z.enum(["perguntar_reserva", "avisar_paciente_reserva"]),
        reserva_id: z.string().uuid(),
      })
      .passthrough(),
    tratarRespostaDaReserva: (...a: unknown[]) => tratarRespostaDaReserva(...a),
    executarTrabalhoDaReserva: (...a: unknown[]) => executarTrabalhoDaReserva(...a),
  };
});
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend: (a: unknown) => runBeforeSend(a) }));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({ runModelCall: (...a: unknown[]) => runModelCall(...a) }));
vi.mock("@/lib/agenda/secretaria/relatos", () => ({
  conferirEAplicarRelato: (...a: unknown[]) => conferirEAplicarRelato(...a),
  registrarRelato: (...a: unknown[]) => registrarRelato(...a),
  marcarRelatoCorrigido: (...a: unknown[]) => marcarRelatoCorrigido(...a),
  descartarRelato: (...a: unknown[]) => descartarRelato(...a),
}));

import { createBastidorTurnHandler } from "@/lib/agent-engine/agent/bastidor-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

/**
 * O HANDLER DO WORKER: liga as portas de verdade ao roteiro. Aqui se prova o que é do encanamento:
 * o papel é RELIDO do banco, a secretaria desligada não faz nada, e toda resposta sai pela cadeia de guardrails
 * declarando `bastidor`.
 */
const ORG = "0be7a70a-0000-4000-8000-000000000001";
const CONTATO = "0be7a70a-0000-4000-8000-000000000002";
const CONVERSA = "0be7a70a-0000-4000-8000-000000000003";
const SESSAO = "0be7a70a-0000-4000-8000-000000000004";
const MENSAGEM = "0be7a70a-0000-4000-8000-000000000005";
const DONO = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-11-17T15:00:00Z");

const job = {
  id: "job-1",
  organization_id: ORG,
  contact_id: CONTATO,
  kind: "bastidor_turn",
  payload: {
    conversation_id: CONVERSA,
    contact_id: CONTATO,
    channel_session_id: SESSAO,
    inbound_message_id: MENSAGEM,
  },
} as unknown as JobRow;

interface Mundo {
  contato?: { papel_interno: string | null; is_blocked: boolean; is_anonymized: boolean } | null;
  settings?: unknown;
  mensagens?: Array<{ body: string | null; media_derived_text: string | null; quando?: Date }>;
  fronteira?: { quando: Date; job_kind: string | null } | null;
  pendente?: { id: string; lido: unknown; created_at: Date } | null;
  jaRegistrado?: { id: string; estado: string; lido: unknown } | null;
  fusoDaJornada?: string | null;
}

function poolFalso(m: Mundo = {}) {
  const sqls: string[] = [];
  const contato = m.contato === undefined ? { papel_interno: "secretaria", is_blocked: false, is_anonymized: false } : m.contato;
  const query = vi.fn().mockImplementation(async (sql: string) => {
    sqls.push(sql);
    if (sql.includes("from contacts")) return { rows: contato ? [contato] : [] };
    if (sql.includes("from organizations")) {
      return {
        rows: [
          {
            timezone: "America/Sao_Paulo",
            settings: m.settings === undefined ? { secretaria: { ativa: true, dono_da_agenda_user_id: DONO } } : m.settings,
          },
        ],
      };
    }
    if (sql.includes("from attendant_availability")) {
      return { rows: m.fusoDaJornada ? [{ tz: m.fusoDaJornada }] : [] };
    }
    if (sql.includes("from messages") && sql.includes("direction = 'outbound'")) {
      // A fronteira (última resposta nossa): por padrão, o resumo do agente.
      const f = m.fronteira === undefined ? { quando: new Date(AGORA.getTime() - 3_600_000), job_kind: "bastidor_turn" } : m.fronteira;
      return { rows: f ? [f] : [] };
    }
    if (sql.includes("from messages") && sql.includes("direction = 'inbound'")) {
      const rows = m.mensagens ?? [{ body: "terça 14h Maria", media_derived_text: null }];
      return { rows: rows.map((r) => ({ quando: AGORA, ...r })) };
    }
    if (sql.includes("from agenda_relatos") && sql.includes("estado = 'lido'")) {
      return { rows: m.pendente ? [m.pendente] : [] };
    }
    if (sql.includes("from agenda_relatos") && sql.includes("message_id")) {
      return { rows: m.jaRegistrado ? [m.jaRegistrado] : [] };
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as pg.Pool, sqls };
}

const canal = { send: vi.fn(async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" })) };
function deps() {
  return {
    crmCfg: { supabase: { fake: true } },
    llmCfg: {},
    knobs: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clock: () => AGORA,
    channel: () => canal,
  } as never;
}

const RESPOSTA_DO_MODELO = JSON.stringify({
  tipo: "relato",
  janela: { de: "2026-11-18", ate: "2026-11-18" },
  marcados: [{ nome: "Maria", inicio: "2026-11-18T14:00" }],
  dias_fechados: [],
  duvidas: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  runBeforeSend.mockImplementation(async (a: { send: (b: string) => Promise<unknown>; body: string }) => ({
    status: "sent",
    outcome: await a.send(a.body),
    trace: [],
  }));
  runModelCall.mockResolvedValue({ result: { text: RESPOSTA_DO_MODELO } });
  reservaEmPerguntaAberta.mockResolvedValue(null);
  tratarRespostaDaReserva.mockResolvedValue(undefined);
  executarTrabalhoDaReserva.mockResolvedValue(undefined);
  registrarRelato.mockResolvedValue({ id: "novo", duplicado: false });
  conferirEAplicarRelato.mockResolvedValue({ relatoId: "pend", jaConferido: false, criados: 1, mantidos: 0, cancelados: 0, diasFechados: 0, diasReabertos: 0 });
  marcarRelatoCorrigido.mockResolvedValue(undefined);
  descartarRelato.mockResolvedValue(undefined);
});

const rodar = (m: Mundo = {}) => {
  const { pool, sqls } = poolFalso(m);
  return createBastidorTurnHandler(deps())(job, pool, { workerId: "w" }).then(() => sqls);
};

describe("bastidor_turn — quem NÃO é atendido", () => {
  it("contato que perdeu o papel: no-op (o papel é relido do banco)", async () => {
    await rodar({ contato: { papel_interno: null, is_blocked: false, is_anonymized: false } });
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(runModelCall).not.toHaveBeenCalled();
  });

  it("papel de marketing não tem conversa nesta versão: no-op", async () => {
    await rodar({ contato: { papel_interno: "marketing", is_blocked: false, is_anonymized: false } });
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("contato inexistente: no-op", async () => {
    await rodar({ contato: null });
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it.each([
    ["bloqueado", { papel_interno: "secretaria", is_blocked: true, is_anonymized: false }],
    ["anonimizado", { papel_interno: "secretaria", is_blocked: false, is_anonymized: true }],
  ])("contato %s: no-op", async (_nome, contato) => {
    await rodar({ contato });
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(runModelCall).not.toHaveBeenCalled();
  });

  it("secretaria NÃO ativada na organização (o padrão): nem lê as mensagens", async () => {
    const sqls = await rodar({ settings: {} });
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(runModelCall).not.toHaveBeenCalled();
    expect(sqls.some((s) => s.includes("from messages"))).toBe(false);
  });

  it("secretaria desligada de forma explícita: idem", async () => {
    await rodar({ settings: { secretaria: { ativa: false, dono_da_agenda_user_id: DONO } } });
    expect(runBeforeSend).not.toHaveBeenCalled();
  });
});

describe("bastidor_turn — relato novo", () => {
  it("lê com o modelo (ponto 'bastidor_leitura'), registra e devolve o resumo PELA cadeia de guardrails", async () => {
    await rodar();
    expect(runModelCall).toHaveBeenCalledTimes(1);
    expect(runModelCall.mock.calls[0]?.[2]).toMatchObject({ tenantId: ORG, leadId: CONTATO, jobId: "job-1", purpose: "bastidor_leitura" });
    expect(registrarRelato).toHaveBeenCalledWith(
      { fake: true },
      expect.objectContaining({ organizationId: ORG, contactId: CONTATO, messageId: MENSAGEM, texto: "terça 14h Maria" }),
    );
    expect(conferirEAplicarRelato).not.toHaveBeenCalled();

    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    const args = runBeforeSend.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      tenantId: ORG,
      leadId: CONTATO,
      jobId: "job-1",
      channelSessionId: SESSAO,
      bastidor: { tipo: "agenda_conferencia" },
      enforceSpinning: false,
    });
    expect(args.body).toContain("Entendi assim:");
    expect(canal.send).toHaveBeenCalledWith(expect.objectContaining({ seq: 1, conversationId: CONVERSA, jobId: "job-1" }));
  });

  it("o fuso vem da jornada do dono da agenda, quando existe", async () => {
    await rodar({ fusoDaJornada: "America/Manaus" });
    const prompt = runModelCall.mock.calls[0]?.[2].messages[0].content as string;
    expect(prompt).toContain("America/Manaus");
  });

  it("sem jornada, o fuso é o da organização", async () => {
    await rodar();
    const prompt = runModelCall.mock.calls[0]?.[2].messages[0].content as string;
    expect(prompt).toContain("America/Sao_Paulo");
  });

  it("áudio sem texto no corpo entra pela transcrição; mensagens em rajada vão juntas, na ordem", async () => {
    await rodar({
      mensagens: [
        { body: "terça 14h Maria", media_derived_text: null },
        { body: null, media_derived_text: "e quinta fechado" },
        { body: "  ", media_derived_text: null },
      ],
    });
    const prompt = runModelCall.mock.calls[0]?.[2].messages[0].content as string;
    expect(prompt).toContain("terça 14h Maria\ne quinta fechado");
  });
});

describe("bastidor_turn — o 'sim' e a correção", () => {
  const PENDENTE = {
    id: "pend",
    lido: {
      janela: { de: "2026-11-18", ate: "2026-11-18" },
      marcados: [{ nome: "Maria", inicio: "2026-11-18T17:00:00.000Z" }],
      dias_fechados: [],
      duvidas: [],
    },
    created_at: new Date(AGORA.getTime() - 5 * 60_000),
  };

  it("'sim' aplica o relato na agenda e confirma — sem chamar o modelo", async () => {
    await rodar({ mensagens: [{ body: "sim", media_derived_text: null }], pendente: PENDENTE });
    expect(conferirEAplicarRelato).toHaveBeenCalledWith({ fake: true }, { organizationId: ORG, relatoId: "pend", agora: AGORA });
    expect(runModelCall).not.toHaveBeenCalled();
    expect(runBeforeSend.mock.calls[0]?.[0].body).toContain("agenda atualizada");
  });

  it("o 'sim' dado 10 min depois do resumo vale mesmo com o job rodando 20 h depois (validade medida até a RESPOSTA)", async () => {
    const criado = new Date(AGORA.getTime() - 20 * 3_600_000);
    await rodar({
      mensagens: [{ body: "Sim", media_derived_text: null, quando: new Date(criado.getTime() + 10 * 60_000) }],
      pendente: { ...PENDENTE, created_at: criado },
    });
    expect(descartarRelato).not.toHaveBeenCalled();
    expect(conferirEAplicarRelato).toHaveBeenCalledTimes(1);
  });

  it("'sim' depois de mensagem HUMANA: não aplica, reenvia o resumo perguntando (o relato continua esperando)", async () => {
    await rodar({
      mensagens: [{ body: "sim", media_derived_text: null }],
      pendente: PENDENTE,
      fronteira: { quando: new Date(AGORA.getTime() - 60_000), job_kind: null },
    });
    expect(conferirEAplicarRelato).not.toHaveBeenCalled();
    expect(descartarRelato).not.toHaveBeenCalled();
    expect(runBeforeSend.mock.calls[0]?.[0].body).toMatch(/esse \*sim\* é para este resumo/);
  });

  it("correção: registra o novo resumo e marca o antigo como corrigido", async () => {
    await rodar({ mensagens: [{ body: "a Maria é às 15h", media_derived_text: null }], pendente: PENDENTE });
    expect(registrarRelato).toHaveBeenCalledTimes(1);
    expect(marcarRelatoCorrigido).toHaveBeenCalledWith({ fake: true }, { organizationId: ORG, relatoId: "pend" });
    expect(conferirEAplicarRelato).not.toHaveBeenCalled();
  });

  it("um resumo ilegível no banco não pode ser confirmado: o 'sim' vira 'nada esperando'", async () => {
    await rodar({
      mensagens: [{ body: "sim", media_derived_text: null }],
      pendente: { id: "pend", lido: { marcados: "lixo" }, created_at: new Date(AGORA.getTime() - 60_000) },
    });
    expect(conferirEAplicarRelato).not.toHaveBeenCalled();
    expect(runBeforeSend.mock.calls[0]?.[0].body).toMatch(/nenhuma agenda esperando/i);
  });

  it("REPLAY do job (a mensagem já gerou resumo): reenvia sem chamar o modelo", async () => {
    await rodar({
      jaRegistrado: { id: "ja", estado: "lido", lido: PENDENTE.lido },
    });
    expect(runModelCall).not.toHaveBeenCalled();
    expect(registrarRelato).not.toHaveBeenCalled();
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
  });
});

describe("bastidor_turn — o 'sim'/'não' de uma RESERVA de horário", () => {
  const RESERVA = { id: "res-1", perguntadaEm: new Date(AGORA.getTime() - 2 * 60_000) };
  const PENDENTE = {
    id: "pend",
    lido: { janela: { de: "2026-11-18", ate: "2026-11-18" }, marcados: [], dias_fechados: [], duvidas: [] },
    created_at: new Date(AGORA.getTime() - 5 * 60_000),
  };

  it("'sim' com pergunta de reserva em aberto vai para a RESERVA — não confere o resumo da agenda nem chama o modelo", async () => {
    reservaEmPerguntaAberta.mockResolvedValue(RESERVA);
    await rodar({ mensagens: [{ body: "sim", media_derived_text: null }] });
    expect(tratarRespostaDaReserva).toHaveBeenCalledTimes(1);
    expect(tratarRespostaDaReserva.mock.calls[0]?.[1]).toBe(RESERVA);
    expect(tratarRespostaDaReserva.mock.calls[0]?.[2]).toBe("sim");
    expect(conferirEAplicarRelato).not.toHaveBeenCalled();
    expect(runModelCall).not.toHaveBeenCalled();
  });

  it("'não' também vai para a reserva", async () => {
    reservaEmPerguntaAberta.mockResolvedValue(RESERVA);
    await rodar({ mensagens: [{ body: "não", media_derived_text: null }] });
    expect(tratarRespostaDaReserva.mock.calls[0]?.[2]).toBe("nao");
  });

  it("o resumo da agenda foi perguntado DEPOIS da reserva: o 'sim' é do resumo (o mais recente manda)", async () => {
    reservaEmPerguntaAberta.mockResolvedValue({ ...RESERVA, perguntadaEm: new Date(AGORA.getTime() - 10 * 60_000) });
    await rodar({ mensagens: [{ body: "sim", media_derived_text: null }], pendente: PENDENTE });
    expect(tratarRespostaDaReserva).not.toHaveBeenCalled();
    expect(conferirEAplicarRelato).toHaveBeenCalledTimes(1);
  });

  it("a reserva foi perguntada DEPOIS do resumo: o 'sim' é da reserva", async () => {
    reservaEmPerguntaAberta.mockResolvedValue(RESERVA);
    await rodar({ mensagens: [{ body: "sim", media_derived_text: null }], pendente: PENDENTE });
    expect(tratarRespostaDaReserva).toHaveBeenCalledTimes(1);
    expect(conferirEAplicarRelato).not.toHaveBeenCalled();
  });

  it("resposta que NÃO é um 'sim'/'não' seco ('sim, mas…') não marca nada: segue o caminho de sempre", async () => {
    reservaEmPerguntaAberta.mockResolvedValue(RESERVA);
    await rodar({ mensagens: [{ body: "sim, mas só às 15h", media_derived_text: null }] });
    expect(tratarRespostaDaReserva).not.toHaveBeenCalled();
    expect(runModelCall).toHaveBeenCalledTimes(1);
  });

  it("sem pergunta de reserva em aberto, 'sim' segue o caminho de sempre", async () => {
    await rodar({ mensagens: [{ body: "sim", media_derived_text: null }] });
    expect(tratarRespostaDaReserva).not.toHaveBeenCalled();
  });

  it("job de TRABALHO da reserva (cron/ferramenta) vai para o executor, sem ler mensagem nem chamar o modelo", async () => {
    const trabalho = {
      ...job,
      payload: {
        conversation_id: CONVERSA,
        contact_id: CONTATO,
        channel_session_id: SESSAO,
        acao: "perguntar_reserva",
        reserva_id: "0be7a70a-0000-4000-8000-000000000009",
      },
    } as unknown as JobRow;
    const { pool } = poolFalso();
    await createBastidorTurnHandler(deps())(trabalho, pool, { workerId: "w" });
    expect(executarTrabalhoDaReserva).toHaveBeenCalledTimes(1);
    expect(executarTrabalhoDaReserva.mock.calls[0]?.[1]).toMatchObject({ acao: "perguntar_reserva" });
    expect(runModelCall).not.toHaveBeenCalled();
    expect(reservaEmPerguntaAberta).not.toHaveBeenCalled();
  });

  it("secretaria desligada: o trabalho da reserva também não faz nada", async () => {
    const trabalho = {
      ...job,
      payload: {
        conversation_id: CONVERSA,
        contact_id: CONTATO,
        channel_session_id: SESSAO,
        acao: "avisar_paciente_reserva",
        reserva_id: "0be7a70a-0000-4000-8000-000000000009",
      },
    } as unknown as JobRow;
    const { pool } = poolFalso({ settings: {} });
    await createBastidorTurnHandler(deps())(trabalho, pool, { workerId: "w" });
    expect(executarTrabalhoDaReserva).not.toHaveBeenCalled();
  });
});

describe("bastidor_turn — falhas", () => {
  it("veto da cadeia NÃO derruba o job (retentar não muda o veredito)", async () => {
    runBeforeSend.mockResolvedValue({ status: "vetoed", gate: "stop", code: "contato_fora_do_funil", message: "x", trace: [] });
    await expect(rodar()).resolves.toBeDefined();
  });

  it("falha do modelo PROPAGA (o job tenta de novo) e nada é enviado", async () => {
    runModelCall.mockRejectedValue(new Error("provedor fora"));
    await expect(rodar()).rejects.toThrow("provedor fora");
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("payload fora do contrato: falha alto (não processa lixo)", async () => {
    const { pool } = poolFalso();
    const ruim = { ...job, payload: { conversation_id: "nao-e-uuid" } } as unknown as JobRow;
    await expect(createBastidorTurnHandler(deps())(ruim, pool, { workerId: "w" })).rejects.toThrow();
  });

  it("job sem contact_id: falha alto", async () => {
    const { pool } = poolFalso();
    const ruim = { ...job, contact_id: null } as unknown as JobRow;
    await expect(createBastidorTurnHandler(deps())(ruim, pool, { workerId: "w" })).rejects.toThrow(/sem contact_id/);
  });
});
