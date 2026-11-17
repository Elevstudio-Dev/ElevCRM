import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";

/**
 * O DESVIO DO DRAIN PARA QUEM TEM PAPEL INTERNO.
 *
 * A mensagem de um contato com `papel_interno` nunca vai ao agente de vendas:
 *   - secretaria  → job `bastidor_turn` (sem exigir agente de vendas publicado, sem o gate de elegibilidade do LEAD);
 *   - marketing   → sem job (ainda não tem conversa);
 *   - sem papel   → `inbound_turn`, exatamente como antes.
 */
const knobs = { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 0, reapTimeoutMs: 60_000 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const CONTATO = "22222222-2222-4222-8222-222222222222";
const evento = {
  id: "e1",
  organization_id: "org1",
  attempts: 1,
  created_at: new Date().toISOString(),
  payload: {
    conversation_id: "11111111-1111-4111-8111-111111111111",
    contact_id: CONTATO,
    channel_session_id: "33333333-3333-4333-8333-333333333333",
    inbound_message_id: "44444444-4444-4444-8444-444444444444",
  },
};

function pool(papel: string | null, opts: { temAgente?: boolean; jobPendente?: boolean } = {}) {
  const chamadas: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const query = vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    chamadas.push({ sql, params });
    if (sql.includes("returning e.id")) return { rows: [evento] };
    if (sql.includes("ai_dispatch_mode")) return { rows: [{ mode: null }] };
    if (sql.includes("is_group")) return { rows: [{ is_group: false }] };
    if (sql.includes("papel_interno")) return { rows: [{ papel_interno: papel }] };
    if (sql.includes("tem_agente")) {
      return { rows: [{ tem_agente: opts.temAgente ?? true, tem_roteador: false }] };
    }
    if (sql.includes("media_derived_status")) return { rows: [{ type: "text", media_derived_status: null }] };
    if (sql.includes("kind = $3") && sql.includes("status = 'pending'")) {
      return { rows: opts.jobPendente ? [{ id: "ja-existe" }] : [] };
    }
    if (sql.includes("insert into job_queue")) {
      return { rows: [{ id: "job1", kind: params?.[2] }] };
    }
    return { rows: [] };
  });
  return { pg: { query } as unknown as pg.Pool, chamadas };
}

const jobCriado = (chamadas: Array<{ sql: string; params: unknown[] | undefined }>) =>
  chamadas.find((c) => c.sql.includes("insert into job_queue"));

describe("drain — secretaria", () => {
  it("enfileira bastidor_turn, não inbound_turn", async () => {
    const { pg: p, chamadas } = pool("secretaria");
    await drainTick(p, knobs, log);
    expect(jobCriado(chamadas)?.params?.[2]).toBe("bastidor_turn");
    expect(chamadas.some((c) => c.params?.[2] === "inbound_turn")).toBe(false);
  });

  it("o job leva o contato e o payload completo (o handler relê o resto do banco)", async () => {
    const { pg: p, chamadas } = pool("secretaria");
    await drainTick(p, knobs, log);
    const insert = jobCriado(chamadas);
    expect(insert?.params?.[1]).toBe(CONTATO);
    expect(insert?.params?.[4]).toMatchObject({
      conversation_id: evento.payload.conversation_id,
      contact_id: CONTATO,
      channel_session_id: evento.payload.channel_session_id,
      inbound_message_id: evento.payload.inbound_message_id,
    });
  });

  it("NÃO exige agente de vendas publicado (a secretaria não depende dele)", async () => {
    const { pg: p, chamadas } = pool("secretaria", { temAgente: false });
    await drainTick(p, knobs, log);
    expect(chamadas.some((c) => c.sql.includes("tem_agente"))).toBe(false);
    expect(jobCriado(chamadas)?.params?.[2]).toBe("bastidor_turn");
  });

  it("a rajada é coalescida pelo tipo CERTO (um job pendente de bastidor absorve a mensagem)", async () => {
    const { pg: p, chamadas } = pool("secretaria", { jobPendente: true });
    await drainTick(p, { ...knobs, debounceMs: 5000 }, log);
    const consulta = chamadas.find((c) => c.sql.includes("kind = $3"));
    expect(consulta?.params).toEqual(["org1", CONTATO, "bastidor_turn"]);
    expect(jobCriado(chamadas)).toBeUndefined();
  });
});

describe("drain — marketing", () => {
  it("sem conversa nesta versão: o evento é consumido SEM job", async () => {
    const { pg: p, chamadas } = pool("marketing");
    await drainTick(p, knobs, log);
    expect(jobCriado(chamadas)).toBeUndefined();
    expect(chamadas.some((c) => c.sql.includes("status = 'done'"))).toBe(true);
  });
});

describe("drain — contato sem papel (nada muda)", () => {
  it("continua virando inbound_turn, com a checagem de agente publicado", async () => {
    const { pg: p, chamadas } = pool(null);
    await drainTick(p, knobs, log);
    expect(chamadas.some((c) => c.sql.includes("tem_agente"))).toBe(true);
    expect(jobCriado(chamadas)?.params?.[2]).toBe("inbound_turn");
  });

  it("sem agente publicado: pulado antes de qualquer gasto, como sempre", async () => {
    const { pg: p, chamadas } = pool(null, { temAgente: false });
    await drainTick(p, knobs, log);
    expect(jobCriado(chamadas)).toBeUndefined();
  });

  it("contato inexistente na leitura do papel (linha ausente): trata como sem papel", async () => {
    const chamadas: string[] = [];
    const query = vi.fn().mockImplementation((sql: string) => {
      chamadas.push(sql);
      if (sql.includes("returning e.id")) return { rows: [evento] };
      if (sql.includes("ai_dispatch_mode")) return { rows: [{ mode: null }] };
      if (sql.includes("is_group")) return { rows: [{ is_group: false }] };
      if (sql.includes("tem_agente")) return { rows: [{ tem_agente: true, tem_roteador: false }] };
      if (sql.includes("media_derived_status")) return { rows: [{ type: "text", media_derived_status: null }] };
      if (sql.includes("insert into job_queue")) return { rows: [{ id: "job1" }] };
      return { rows: [] }; // inclusive a leitura do papel
    });
    await drainTick({ query } as unknown as pg.Pool, knobs, log);
    expect(chamadas.some((s) => s.includes("insert into job_queue"))).toBe(true);
  });
});
