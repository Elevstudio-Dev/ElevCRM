import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { lerMensagensDesdeAUltimaResposta } from "@/lib/agent-engine/agent/bastidor-mensagens";

/**
 * O "SIM" QUE SE PERDIA — a leitura das mensagens da secretaria contra o Postgres de verdade.
 *
 * Produção: resumo enviado → ela respondeu "Sim" minutos depois → o job falhou → o cron mandou a pergunta do fim do
 * dia e o lembrete POR CIMA. Como a fronteira era "a última saída de qualquer tipo", o "Sim" ficou antes dela e o
 * turno passou a ler texto vazio. A fronteira agora ignora as mensagens AUTOMÁTICAS de agenda, reconhecidas pelo
 * caminho real do envio: `messages.metadata.idempotency_key` → `send_ledger.id` → `job_queue` (`bastidor_turn` com
 * `payload.acao` de pergunta/lembrete). Só o banco tem esse caminho; nenhum mock o prova.
 *
 * Dados sintéticos.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 2 });

const ORG = "5e5e0000-0000-4000-8000-000000000001";
const SECRETARIA = "5e5e0000-0000-4000-8000-000000000002";
const SESSAO = "5e5e0000-0000-4000-8000-000000000003";
const CONVERSA = "5e5e0000-0000-4000-8000-000000000004";

/** Relógio da conversa: minutos depois das 12h UTC de um dia qualquer. */
const t = (min: number) => new Date(Date.UTC(2026, 10, 18, 12, 0) + min * 60_000);

let seq = 0;

async function entrada(body: string, quando: Date) {
  await pool.query(
    `insert into messages (organization_id, conversation_id, contact_id, channel_session_id, direction, type, body, sent_at)
     values ($1, $2, $3, $4, 'inbound', 'text', $5, $6)`,
    [ORG, CONVERSA, SECRETARIA, SESSAO, body, quando],
  );
}

/**
 * Uma saída do AGENTE como o envio real a grava: job na fila → linha no ledger → mensagem com a chave do ledger.
 * `acao` ausente = o job que nasce de uma mensagem dela (resumo, resposta fixa do turno).
 */
async function saidaDoAgente(body: string, quando: Date, acao?: string, status = "sent") {
  const payload = acao === undefined ? { conversation_id: CONVERSA } : { conversation_id: CONVERSA, acao };
  const { rows: job } = await pool.query<{ id: string }>(
    `insert into job_queue (organization_id, contact_id, kind, payload, status) values ($1, $2, 'bastidor_turn', $3, 'done') returning id`,
    [ORG, SECRETARIA, JSON.stringify(payload)],
  );
  const { rows: ledger } = await pool.query<{ id: string }>(
    `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status) values ($1, $2, $3, $4, 'h', 'accepted') returning id`,
    [ORG, SECRETARIA, job[0]!.id, ++seq],
  );
  await pool.query(
    `insert into messages (organization_id, conversation_id, contact_id, channel_session_id, direction, type, body, sent_at, status, sent_via, metadata)
     values ($1, $2, $3, $4, 'outbound', 'text', $5, $6, $7, 'ai', jsonb_build_object('idempotency_key', $8::text))`,
    [ORG, CONVERSA, SECRETARIA, SESSAO, body, quando, status, ledger[0]!.id],
  );
}

/** Uma saída HUMANA: alguém da equipe escreveu do aparelho (sem ledger, sem job). */
async function saidaHumana(body: string, quando: Date) {
  await pool.query(
    `insert into messages (organization_id, conversation_id, contact_id, channel_session_id, direction, type, body, sent_at, sent_via)
     values ($1, $2, $3, $4, 'outbound', 'text', $5, $6, 'external_device')`,
    [ORG, CONVERSA, SECRETARIA, SESSAO, body, quando],
  );
}

const ler = () => lerMensagensDesdeAUltimaResposta(pool, ORG, CONVERSA);

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, 'org-sim-perdido', 'Sim Perdido LTDA', 'Sim')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(`insert into contacts (id, organization_id, display_name) values ($1, $2, 'Secretaria Sintetica') on conflict (id) do nothing`, [
    SECRETARIA,
    ORG,
  ]);
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
     values ($1, $2, 'sim-perdido', '\\x00', 'WORKING') on conflict (id) do nothing`,
    [SESSAO, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [CONVERSA, ORG, SECRETARIA, SESSAO],
  );
});

beforeEach(async () => {
  await pool.query(`delete from messages where organization_id = $1`, [ORG]);
  await pool.query(`delete from job_queue where organization_id = $1`, [ORG]); // o ledger vai junto (cascade)
});

afterAll(async () => {
  await pool.end();
});

describe("o caso de produção: o 'sim' veio ANTES das mensagens automáticas", () => {
  it("resumo → 'Sim' 8 min depois → pergunta do fim do dia → lembrete: o turno ainda lê o 'Sim'", async () => {
    await saidaDoAgente("Entendi assim: … Está certo?", t(0)); // o resumo (job sem acao)
    await entrada("Sim", t(8));
    await saidaDoAgente("Antes de encerrar o dia: como ficou a agenda…", t(300), "perguntar");
    await saidaDoAgente("Só relembrando a agenda…", t(330), "lembrar");

    const r = await ler();
    expect(r.texto).toBe("Sim");
    // A validade do resumo é medida até AQUI (quando ela respondeu), não até a hora em que o job rodar.
    expect(r.respondeuEm?.toISOString()).toBe(t(8).toISOString());
    expect(r.ultimaRespostaNossa).toBe("bastidor");
  });

  it("resumo → lembrete automático → 'sim': lê o 'sim'", async () => {
    await saidaDoAgente("Entendi assim: … Está certo?", t(0));
    await saidaDoAgente("Falta só você confirmar o resumo…", t(60), "lembrar_conferencia");
    await entrada("sim", t(70));
    const r = await ler();
    expect(r.texto).toBe("sim");
    expect(r.ultimaRespostaNossa).toBe("bastidor");
  });

  it("o que ela escreveu ANTES do resumo não entra (o resumo é fronteira)", async () => {
    await entrada("hoje 14h Fulano", t(-5));
    await saidaDoAgente("Entendi assim: … Está certo?", t(0));
    await entrada("sim", t(3));
    expect((await ler()).texto).toBe("sim");
  });
});

describe("o que CONTA como resposta nossa (fronteira)", () => {
  it("mensagem HUMANA depois do resumo é fronteira — e o turno sabe que foi humana", async () => {
    await saidaDoAgente("Entendi assim: … Está certo?", t(0));
    await entrada("ok, vou ver", t(2));
    await saidaHumana("Cris, a paciente das 10h confirmou?", t(5));
    await entrada("sim", t(6));
    const r = await ler();
    expect(r.texto).toBe("sim");
    expect(r.ultimaRespostaNossa).toBe("humana");
  });

  it("a pergunta de RESERVA é fronteira (é o agente perguntando outra coisa, não lembrete de agenda)", async () => {
    await saidaDoAgente("Entendi assim: … Está certo?", t(0));
    await entrada("antes", t(1));
    await saidaDoAgente("Posso marcar a paciente às 15h?", t(5), "perguntar_reserva");
    await entrada("sim", t(6));
    expect((await ler()).texto).toBe("sim");
  });

  it("saída que FALHOU não chegou a ela e não é fronteira", async () => {
    await saidaDoAgente("Entendi assim: … Está certo?", t(0));
    await entrada("sim", t(2));
    await saidaDoAgente("Pronto, agenda atualizada", t(3), undefined, "failed");
    expect((await ler()).texto).toBe("sim");
  });

  it("sem resposta nossa nenhuma: lê o que houver e diz 'nenhuma'", async () => {
    await entrada("oi", t(0));
    const r = await ler();
    expect(r).toMatchObject({ texto: "oi", ultimaRespostaNossa: "nenhuma" });
  });

  it("nada depois da fronteira: texto vazio e sem horário de resposta", async () => {
    await entrada("sim", t(0));
    await saidaDoAgente("Pronto, agenda atualizada", t(1));
    expect(await ler()).toEqual({ texto: "", respondeuEm: null, ultimaRespostaNossa: "bastidor" });
  });

  it("isolamento: mensagens de OUTRA organização com o mesmo id de conversa não entram", async () => {
    await saidaDoAgente("Entendi assim: … Está certo?", t(0));
    await entrada("sim", t(1));
    const outra = await lerMensagensDesdeAUltimaResposta(pool, "5e5e0000-0000-4000-8000-0000000000ff", CONVERSA);
    expect(outra).toEqual({ texto: "", respondeuEm: null, ultimaRespostaNossa: "nenhuma" });
  });
});
