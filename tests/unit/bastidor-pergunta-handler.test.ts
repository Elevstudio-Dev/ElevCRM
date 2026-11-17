// @vitest-environment node
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runBeforeSend = vi.fn();
const runModelCall = vi.fn();

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend: (a: unknown) => runBeforeSend(a) }));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({ runModelCall: (...a: unknown[]) => runModelCall(...a) }));

import { createBastidorTurnHandler } from "@/lib/agent-engine/agent/bastidor-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { TEXTO_DO_LEMBRETE_DA_PERGUNTA, textoDaPergunta } from "@/lib/bastidor/secretaria/textos";

/**
 * O job do CRON das perguntas diárias (sem mensagem dela): perguntar ou lembrar a agenda. Aqui se prova o que é do
 * encanamento: as mesmas guardas do turno de mensagem (papel relido, secretaria ligada), as duas guardas próprias
 * (pedido velho, lembrete de pergunta já respondida), o tipo certo de mensagem de bastidor e que NENHUM modelo é
 * chamado (a pergunta é texto fixo).
 */
const ORG = "0be7a70a-0000-4000-8000-000000000001";
const CONTATO = "0be7a70a-0000-4000-8000-000000000002";
const CONVERSA = "0be7a70a-0000-4000-8000-000000000003";
const SESSAO = "0be7a70a-0000-4000-8000-000000000004";
const AGORA = new Date("2026-11-17T11:35:00Z"); // 08:35 em São Paulo

const jobDe = (acao: "perguntar" | "lembrar", horario = "08:30", criado: Date = AGORA): JobRow =>
  ({
    id: "job-p",
    organization_id: ORG,
    contact_id: CONTATO,
    kind: "bastidor_turn",
    created_at: criado,
    payload: {
      conversation_id: CONVERSA,
      contact_id: CONTATO,
      channel_session_id: SESSAO,
      acao,
      dia: "2026-11-17",
      horario,
    },
  }) as unknown as JobRow;

interface Mundo {
  contato?: { papel_interno: string | null; is_blocked: boolean; is_anonymized: boolean } | null;
  settings?: unknown;
  /** Linha de `agenda_perguntas` para o lembrete: respondeu ou não; `null` = a pergunta não existe mais. */
  respondeu?: boolean | null;
}

function poolFalso(m: Mundo = {}) {
  const sqls: string[] = [];
  const contato = m.contato === undefined ? { papel_interno: "secretaria", is_blocked: false, is_anonymized: false } : m.contato;
  const query = vi.fn().mockImplementation(async (sql: string) => {
    sqls.push(sql);
    if (sql.includes("from agenda_perguntas")) {
      return { rows: m.respondeu === null ? [] : [{ respondeu: m.respondeu ?? false }] };
    }
    if (sql.includes("from contacts")) return { rows: contato ? [contato] : [] };
    if (sql.includes("from organizations")) {
      return {
        rows: [{ timezone: "America/Sao_Paulo", settings: m.settings === undefined ? { secretaria: { ativa: true } } : m.settings }],
      };
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as pg.Pool, sqls };
}

const canal = { send: vi.fn(async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" })) };
const deps = () =>
  ({
    crmCfg: { supabase: { fake: true } },
    llmCfg: {},
    knobs: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clock: () => AGORA,
    channel: () => canal,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  runBeforeSend.mockImplementation(async (a: { send: (b: string) => Promise<unknown>; body: string }) => ({
    status: "sent",
    outcome: await a.send(a.body),
    trace: [],
  }));
});

const rodar = (job: JobRow, m: Mundo = {}) => {
  const { pool, sqls } = poolFalso(m);
  return createBastidorTurnHandler(deps())(job, pool, { workerId: "w" }).then(() => sqls);
};

describe("perguntar", () => {
  it("manda o texto fixo da pergunta pela cadeia, como agenda_pergunta, sem chamar modelo", async () => {
    await rodar(jobDe("perguntar"));
    expect(runModelCall).not.toHaveBeenCalled();
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    const args = runBeforeSend.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      tenantId: ORG,
      leadId: CONTATO,
      jobId: "job-p",
      channelSessionId: SESSAO,
      bastidor: { tipo: "agenda_pergunta" },
      body: textoDaPergunta("08:30"),
      enforceSpinning: false,
    });
    expect(canal.send).toHaveBeenCalledWith(expect.objectContaining({ conversationId: CONVERSA, body: textoDaPergunta("08:30") }));
  });

  it("o cumprimento acompanha o horário da pergunta (14:00 = boa tarde)", async () => {
    await rodar(jobDe("perguntar", "14:00"));
    expect(runBeforeSend.mock.calls[0]?.[0].body).toMatch(/^Boa tarde!/);
  });

  it("pedido que esperou na fila mais de 2 h (worker parado): não envia", async () => {
    await rodar(jobDe("perguntar", "08:30", new Date(AGORA.getTime() - 121 * 60_000)));
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("pedido de 2 h em ponto ainda vale", async () => {
    await rodar(jobDe("perguntar", "08:30", new Date(AGORA.getTime() - 120 * 60_000)));
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
  });

  it("veto da cadeia (janela, canal) NÃO derruba o job", async () => {
    runBeforeSend.mockResolvedValue({ status: "vetoed", gate: "pacing", code: "outside_window", trace: [] });
    await expect(rodar(jobDe("perguntar"))).resolves.toBeDefined();
  });
});

describe("lembrar", () => {
  it("pergunta sem resposta: manda o lembrete fixo como agenda_lembrete", async () => {
    await rodar(jobDe("lembrar"), { respondeu: false });
    expect(runBeforeSend.mock.calls[0]?.[0]).toMatchObject({
      bastidor: { tipo: "agenda_lembrete" },
      body: TEXTO_DO_LEMBRETE_DA_PERGUNTA,
    });
  });

  it("ela respondeu enquanto o lembrete esperava na fila: não envia", async () => {
    await rodar(jobDe("lembrar"), { respondeu: true });
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("a pergunta não existe mais: não envia lembrete de nada", async () => {
    await rodar(jobDe("lembrar"), { respondeu: null });
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("a PERGUNTA não consulta resposta (só o lembrete consulta)", async () => {
    const sqls = await rodar(jobDe("perguntar"));
    expect(sqls.some((s) => s.includes("from agenda_perguntas"))).toBe(false);
  });
});

describe("as mesmas guardas do turno de mensagem", () => {
  it("contato que perdeu o papel: no-op", async () => {
    await rodar(jobDe("perguntar"), { contato: { papel_interno: null, is_blocked: false, is_anonymized: false } });
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("contato bloqueado: no-op", async () => {
    await rodar(jobDe("perguntar"), { contato: { papel_interno: "secretaria", is_blocked: true, is_anonymized: false } });
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("secretaria desligada na organização: no-op", async () => {
    await rodar(jobDe("perguntar"), { settings: {} });
    expect(runBeforeSend).not.toHaveBeenCalled();
  });
});

describe("payload", () => {
  it("horário torto no payload falha alto (o job tenta de novo e morre), não envia texto errado", async () => {
    const job = { ...jobDe("perguntar"), payload: { ...jobDe("perguntar").payload, horario: "8h30" } } as JobRow;
    await expect(rodar(job)).rejects.toThrow();
    expect(runBeforeSend).not.toHaveBeenCalled();
  });
});
