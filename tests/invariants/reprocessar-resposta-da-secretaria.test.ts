import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

// A cadeia de guardrails do envio tem gates próprios (janela, canal) que não são o assunto aqui: ela só repassa ao
// canal falso. Todo o resto do turno — leitura das mensagens, resumo pendente, aplicador — roda de verdade no banco.
const runBeforeSend = vi.fn(async (a: { send: (b: string) => Promise<unknown>; body: string }) => ({
  status: "sent",
  outcome: await a.send(a.body),
  trace: [],
}));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend: (a: never) => runBeforeSend(a) }));

import { createBastidorTurnHandler } from "@/lib/agent-engine/agent/bastidor-turn";
import { claimJobs } from "@/lib/agent-engine/queue/queue";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * O SCRIPT OPERACIONAL que reprocessa o "sim" de uma secretária que não foi aplicado — o SQL de verdade
 * (`hostgator-setup-kit/reprocessar-resposta-da-secretaria.sql`), rodado pelo psql de verdade, contra o schema de
 * verdade, num cenário igual ao de produção (dados sintéticos):
 *
 *   resumo do relato (lido) → "Sim" 8 min depois → o turno morreu (job dead) → pergunta e lembrete do cron por cima.
 *
 * O que se prova: a prévia (padrão) não escreve NADA e mostra o que o operador precisa; `aplicar=1` enfileira UM job
 * com o payload do original e mais nada; e cada recusa (relato não-lido, organização errada, resposta fora das 12 h,
 * turno já na fila) não escreve nada.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
const CONTAINER: string = container;

const SQL = readFileSync(join(process.cwd(), "hostgator-setup-kit/reprocessar-resposta-da-secretaria.sql"), "utf8");
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 2 });

const ORG = "4e940000-0000-4000-8000-000000000001";
const OUTRA_ORG = "4e940000-0000-4000-8000-0000000000ff";
const DONO = "4e940000-0000-4000-8000-000000000002";
const SECRETARIA = "4e940000-0000-4000-8000-000000000003";
const SESSAO = "4e940000-0000-4000-8000-000000000004";
const CONVERSA = "4e940000-0000-4000-8000-000000000005";
const MSG_AGENDA = "4e940000-0000-4000-8000-0000000000b1";
const MSG_SIM = "4e940000-0000-4000-8000-0000000000b2";
const RELATO = "4e940000-0000-4000-8000-0000000000a1";
const JOB_MORTO = "4e940000-0000-4000-8000-0000000000d1";

const t = (min: number) => new Date(Date.UTC(2026, 10, 18, 20, 0) + min * 60_000); // 17h em Brasília + min

/** O relógio injetado do script: 48 h depois do resumo (o "sim" de anteontem que ficou para trás). */
const AGORA_DO_SCRIPT = () => t(48 * 60).toISOString();

function reprocessar(v: { org?: string; msg?: string; relato?: string; job?: string; aplicar?: boolean; agora?: string }) {
  const args = ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"];
  for (const [k, val] of Object.entries({
    org: v.org ?? ORG,
    msg: v.msg ?? "",
    relato: v.relato ?? "",
    job: v.job ?? "",
    aplicar: v.aplicar ? "1" : "0",
    agora: v.agora ?? AGORA_DO_SCRIPT(),
  })) {
    args.push("-v", `${k}=${val}`);
  }
  args.push("-f", "-");
  const r = spawnSync("docker", args, { input: SQL, encoding: "utf8" });
  return { ok: r.status === 0, saida: r.stdout, erro: r.stderr };
}

const jobs = async () =>
  (
    await pool.query<{ id: string; status: string; payload: Record<string, unknown>; source_event_id: string | null }>(
      `select id, status, payload, source_event_id from job_queue where organization_id = $1 order by created_at`,
      [ORG],
    )
  ).rows;

async function saidaDoAgente(quando: Date, acao?: string) {
  const payload = acao ? { conversation_id: CONVERSA, acao } : { conversation_id: CONVERSA };
  const { rows: j } = await pool.query<{ id: string }>(
    `insert into job_queue (organization_id, contact_id, kind, payload, status) values ($1, $2, 'bastidor_turn', $3, 'done') returning id`,
    [ORG, SECRETARIA, JSON.stringify(payload)],
  );
  const { rows: l } = await pool.query<{ id: string }>(
    `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status) values ($1, $2, $3, 1, 'h', 'accepted') returning id`,
    [ORG, SECRETARIA, j[0]!.id],
  );
  await pool.query(
    `insert into messages (organization_id, conversation_id, contact_id, channel_session_id, direction, type, body, sent_at, status, sent_via, metadata)
     values ($1, $2, $3, $4, 'outbound', 'text', 'saida', $5, 'sent', 'ai', jsonb_build_object('idempotency_key', $6::text))`,
    [ORG, CONVERSA, SECRETARIA, SESSAO, quando, l[0]!.id],
  );
}

beforeAll(async () => {
  await pool.query(`insert into auth.users (id, email) values ($1, 'dono-reproc@invariant.test') on conflict do nothing`, [DONO]);
  for (const [id, slug] of [
    [ORG, "org-reprocessar"],
    [OUTRA_ORG, "org-reprocessar-outra"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name, timezone, settings)
       values ($1, $2, 'Reprocessar LTDA', 'Reprocessar', 'America/Sao_Paulo',
               jsonb_build_object('secretaria', jsonb_build_object('ativa', true, 'dono_da_agenda_user_id', $3::text)))
       on conflict (id) do nothing`,
      [id, slug, DONO],
    );
  }
  await pool.query(
    `insert into contacts (id, organization_id, display_name, papel_interno, fora_do_funil_em) values ($1, $2, 'Secretaria Sintetica', 'secretaria', now())
     on conflict (id) do nothing`,
    [SECRETARIA, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
     values ($1, $2, 'reprocessar', '\\x00', 'WORKING') on conflict (id) do nothing`,
    [SESSAO, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [CONVERSA, ORG, SECRETARIA, SESSAO],
  );
});

beforeEach(async () => {
  await pool.query(`delete from agenda_relatos where organization_id = $1`, [ORG]);
  await pool.query(`delete from messages where organization_id = $1`, [ORG]);
  await pool.query(`delete from job_queue where organization_id = $1`, [ORG]);
  await pool.query(`delete from calendar_appointments where organization_id = $1`, [ORG]);
  await pool.query(`delete from calendar_availability_exceptions where organization_id = $1`, [ORG]);

  // A agenda dela (a mensagem que gerou o relato) e o relato lido.
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, contact_id, channel_session_id, direction, type, body, sent_at)
     values ($1, $2, $3, $4, $5, 'inbound', 'text', 'a agenda de amanhã é…', $6)`,
    [MSG_AGENDA, ORG, CONVERSA, SECRETARIA, SESSAO, t(-2)],
  );
  await pool.query(
    `insert into agenda_relatos (id, organization_id, contact_id, message_id, texto, lido, janela_de, janela_ate, estado, created_at)
     values ($1, $2, $3, $4, 'a agenda de amanhã é…', $5::jsonb, '2026-11-19', '2026-11-20', 'lido', $6)`,
    [
      RELATO,
      ORG,
      SECRETARIA,
      MSG_AGENDA,
      JSON.stringify({
        janela: { de: "2026-11-19", ate: "2026-11-20" },
        marcados: [
          { nome: "Paciente C", inicio: "2026-11-19T11:30:00.000Z" },
          { nome: "Paciente E", inicio: "2026-11-19T13:00:00.000Z" },
        ],
        dias_fechados: [{ data: "2026-11-20", motivo: "feriado" }],
        duvidas: [],
      }),
      t(0),
    ],
  );
  // O relato anterior deixou "Paciente A" às 08:30 (vai ser TROCADO) e "Paciente E" (mantido).
  await pool.query(
    `insert into agenda_relatos (id, organization_id, contact_id, texto, lido, janela_de, janela_ate, estado, conferido_em, created_at)
     values ('4e940000-0000-4000-8000-0000000000a0', $1, $2, 'antigo', '{}'::jsonb, '2026-11-19', '2026-11-20', 'conferido', $3, $3)`,
    [ORG, SECRETARIA, t(-600)],
  );
  for (const [nome, inicio] of [
    ["Paciente A", "2026-11-19T11:30:00Z"],
    ["Paciente E", "2026-11-19T13:00:00Z"],
  ]) {
    await pool.query(
      `insert into calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id, created_by_kind, source, origem_relato_id, google_synced_at)
       values ($1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes', $4, 'ai', 'mcp', '4e940000-0000-4000-8000-0000000000a0', now())`,
      [ORG, nome, inicio, DONO],
    );
  }

  // O resumo saiu (job do turno) → "Sim" 8 min depois → o turno MORREU → pergunta e lembrete do cron por cima.
  await saidaDoAgente(t(1));
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, contact_id, channel_session_id, direction, type, body, sent_at)
     values ($1, $2, $3, $4, $5, 'inbound', 'text', 'Sim', $6)`,
    [MSG_SIM, ORG, CONVERSA, SECRETARIA, SESSAO, t(8)],
  );
  await pool.query(
    `insert into job_queue (id, organization_id, contact_id, kind, payload, status, attempts, last_error)
     values ($1, $2, $3, 'bastidor_turn', $4, 'dead', 5, 'A agenda que a secretária confirmou não foi aplicada. Motivo: …')`,
    [
      JOB_MORTO,
      ORG,
      SECRETARIA,
      JSON.stringify({ conversation_id: CONVERSA, contact_id: SECRETARIA, channel_session_id: SESSAO, inbound_message_id: MSG_SIM }),
    ],
  );
  await saidaDoAgente(t(75), "perguntar");
  await saidaDoAgente(t(105), "lembrar");
});

afterAll(async () => {
  await pool.end();
});

describe("a prévia (padrão): mostra e NÃO escreve nada", () => {
  it("pelo job que morreu: acha a mensagem, o relato, mede a validade até a resposta e mostra o plano", async () => {
    const antes = await jobs();
    const r = reprocessar({ job: JOB_MORTO });
    expect(r.erro).toBe("");
    expect(r.ok).toBe(true);
    expect(r.saida).toContain(`Relato (resumo): ${RELATO} · estado lido`);
    expect(r.saida).toContain(`Mensagem do "sim": ${MSG_SIM}`);
    // O turno lê o "Sim" mesmo com a pergunta e o lembrete do cron DEPOIS dele (a fronteira os ignora).
    expect(r.saida).toContain('O turno vai ler 1 mensagem(ns) dela; a última, 18/11 17:08: "Sim"');
    expect(r.saida).toContain("Última resposta nossa antes disso: do agente");
    expect(r.saida).toContain("Validade: ela respondeu 00:08:00 depois do resumo (limite 12 h) → vale");
    // I1: o carimbo é a hora da RESPOSTA, e a prévia diz o efeito na IA de vendas (resposta de dias atrás → nada).
    expect(r.saida).toContain("Carimbo de conferência (conferido_em): 18/11 17:08 — a hora em que ela respondeu");
    expect(r.saida).toMatch(/Frescura da agenda depois de aplicar, agora: desatualizada \(validades da clínica: hoje 6 h, próximos dias 24 h\) → a IA de vendas NÃO oferece horários/);
    expect(r.saida).toContain('19/11 08:30 Paciente C → troca: cancela "Paciente A" e cria');
    expect(r.saida).toContain("19/11 10:00 Paciente E → mantém");
    expect(r.saida).toContain("dia 20/11 → fecha");
    expect(r.saida).toContain(`PRÉVIA: nada foi alterado. O job novo copiaria o payload do job ${JOB_MORTO}.`);
    expect(await jobs()).toEqual(antes);
  });

  const comConfig = async (caminho: string, valor: unknown, rodar: () => Promise<void>) => {
    await pool.query(`update organizations set settings = jsonb_set(settings, $2::text[], $3::jsonb) where id = $1`, [
      ORG,
      `{${caminho}}`,
      JSON.stringify(valor),
    ]);
    try {
      await rodar();
    } finally {
      await pool.query(
        `update organizations set settings = jsonb_build_object('secretaria', jsonb_build_object('ativa', true, 'dono_da_agenda_user_id', $2::text)) where id = $1`,
        [ORG, DONO],
      );
    }
  };

  it("a frescura usa as validades CONFIGURADAS da clínica (uma semana — o teto — para os próximos dias → sem_hoje)", async () => {
    await comConfig("secretaria,validade_futuro_horas", 168, async () => {
      const r = reprocessar({ job: JOB_MORTO });
      expect(r.saida).toMatch(/agora: sem_hoje \(validades da clínica: hoje 6 h, próximos dias 168 h\) → a IA de vendas só oferece de amanhã em diante/);
    });
  });

  it("validade FORA DA FAIXA do app (o app lê como desligada): recusa, sem escrever", async () => {
    await comConfig("secretaria,validade_futuro_horas", 8760, async () => {
      const r = reprocessar({ job: JOB_MORTO, aplicar: true });
      expect(r.ok).toBe(false);
      expect(r.erro).toMatch(/Recusado: a configuração da secretaria tem valor fora da faixa/);
    });
    await comConfig("secretaria,validade_hoje_horas", 0.25, async () => {
      expect(reprocessar({ job: JOB_MORTO }).erro).toMatch(/fora da faixa/);
    });
    expect((await jobs()).filter((j) => j.status === "pending")).toHaveLength(0);
  });

  it("secretaria DESLIGADA na organização: recusa", async () => {
    await comConfig("secretaria,ativa", false, async () => {
      const r = reprocessar({ job: JOB_MORTO, aplicar: true });
      expect(r.ok).toBe(false);
      expect(r.erro).toMatch(/Recusado: a agenda da secretaria não está ligada/);
    });
  });

  it("I2 por palavras inteiras na prévia: contato só com `name` casa; 'Paciente C' NÃO casa com 'Paciente Cesar'", async () => {
    const soNome = "4e940000-0000-4000-8000-0000000000e2";
    await pool.query(
      `insert into contacts (id, organization_id, name, display_name) values ($1, $2, 'Paciente C Sintetico', null) on conflict (id) do nothing`,
      [soNome, ORG],
    );
    await pool.query(`delete from calendar_appointments where organization_id = $1 and title = 'Paciente A'`, [ORG]);
    await pool.query(
      `insert into calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id, contact_id, created_by_kind, source)
       values ($1, 'Avaliação', '2026-11-19T11:30:00Z', '2026-11-19T12:00:00Z', $2, $3, 'ai', 'mcp')`,
      [ORG, DONO, soNome],
    );
    expect(reprocessar({ job: JOB_MORTO }).saida).toContain("19/11 08:30 Paciente C → já está na agenda");

    await pool.query(`update calendar_appointments set contact_id = null, title = 'Paciente Cesar' where organization_id = $1 and title = 'Avaliação'`, [ORG]);
    expect(reprocessar({ job: JOB_MORTO }).saida).toContain("19/11 08:30 Paciente C → NÃO cria");
  });

  it("I2: o MESMO paciente já marcado pela IA de vendas no horário aparece como 'já está na agenda', não como conflito", async () => {
    const contato = "4e940000-0000-4000-8000-0000000000e1";
    await pool.query(
      `insert into contacts (id, organization_id, display_name) values ($1, $2, 'Paciente C Sintetico') on conflict (id) do nothing`,
      [contato, ORG],
    );
    await pool.query(`delete from calendar_appointments where organization_id = $1 and title = 'Paciente A'`, [ORG]);
    await pool.query(
      `insert into calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id, contact_id, created_by_kind, source)
       values ($1, 'Avaliação', '2026-11-19T11:30:00Z', '2026-11-19T12:00:00Z', $2, $3, 'ai', 'mcp')`,
      [ORG, DONO, contato],
    );
    const r = reprocessar({ job: JOB_MORTO });
    expect(r.saida).toContain("19/11 08:30 Paciente C → já está na agenda (marcado por outro caminho)");
  });

  it("pela mensagem ou pelo relato chega ao MESMO lugar", () => {
    expect(reprocessar({ msg: MSG_SIM }).saida).toContain(`Relato (resumo): ${RELATO}`);
    const peloRelato = reprocessar({ relato: RELATO });
    expect(peloRelato.ok).toBe(true);
    expect(peloRelato.saida).toContain(`Mensagem do "sim": ${MSG_SIM}`);
  });
});

describe("--aplicar: enfileira UM job, com o payload do original, e nada mais", () => {
  it("um job bastidor_turn novo, pendente, sem source_event_id, com a marca de onde veio", async () => {
    const r = reprocessar({ job: JOB_MORTO, aplicar: true });
    expect(r.erro).toBe("");
    expect(r.saida).toMatch(/ENFILEIRADO: job [0-9a-f-]{36} \(bastidor_turn, cópia do job /);
    const novos = (await jobs()).filter((j) => j.status === "pending");
    expect(novos).toHaveLength(1);
    expect(novos[0]!.source_event_id).toBeNull();
    expect(novos[0]!.payload).toEqual({
      conversation_id: CONVERSA,
      contact_id: SECRETARIA,
      channel_session_id: SESSAO,
      inbound_message_id: MSG_SIM,
      reprocessado_de: JOB_MORTO,
    });
    // Nada além da fila: relato e agenda intocados (quem aplica é o worker).
    const { rows } = await pool.query(`select estado from agenda_relatos where id = $1`, [RELATO]);
    expect(rows[0].estado).toBe("lido");
    const { rows: ag } = await pool.query(
      `select count(*)::int as n from calendar_appointments where organization_id = $1 and status = 'confirmed'`,
      [ORG],
    );
    expect(ag[0].n).toBe(2);
  });

  it("rodar --aplicar de novo é RECUSADO (o turno dela já está na fila) e não empilha outro", async () => {
    reprocessar({ job: JOB_MORTO, aplicar: true });
    const r = reprocessar({ job: JOB_MORTO, aplicar: true });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/Recusado: já há um turno da secretaria na fila/);
    expect((await jobs()).filter((j) => j.status === "pending")).toHaveLength(1);
  });
});

describe("o reprocessamento BASTA: o job enfileirado, rodado pelo handler real, aplica a agenda", () => {
  it("dia seguinte (14 h depois do resumo): o turno lê o 'Sim' por cima do lembrete, mede a validade até a resposta e aplica a troca", async () => {
    expect(reprocessar({ job: JOB_MORTO, aplicar: true }).ok).toBe(true);
    const [job] = await claimJobs(pool, { workerId: "reprocessar", maxConcurrency: 8 });
    expect(job?.payload).toMatchObject({ inbound_message_id: MSG_SIM, reprocessado_de: JOB_MORTO });

    const enviados: string[] = [];
    const deps = {
      crmCfg: { supabase: pgComoSupabase(pool) },
      llmCfg: {},
      knobs: {},
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      clock: () => t(14 * 60), // 19/11 07h em Brasília: 14 h depois do resumo, 13h52 depois do "Sim"
      channel: () => ({
        send: async (i: { body: string }) => {
          enviados.push(i.body);
          return { kind: "sent", idempotencyKey: "k", messageId: "m" };
        },
      }),
    } as never;
    await createBastidorTurnHandler(deps)(job!, pool, { workerId: "reprocessar" });

    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatch(/^Pronto, agenda atualizada \(1 horário anotado, 1 removido, 1 dia fechado\)/);
    const { rows: relato } = await pool.query<{ estado: string; conferido_em: Date }>(
      `select estado, conferido_em from agenda_relatos where id = $1`,
      [RELATO],
    );
    expect(relato[0]!.estado).toBe("conferido");
    // I1: carimbado na hora do "Sim" (17:08), não na do job (07h do dia seguinte).
    expect(relato[0]!.conferido_em.toISOString()).toBe(t(8).toISOString());
    const { rows: vivos } = await pool.query<{ title: string }>(
      `select title from calendar_appointments where organization_id = $1 and status in ('pending','confirmed') order by starts_at`,
      [ORG],
    );
    expect(vivos.map((v) => v.title)).toEqual(["Paciente C", "Paciente E"]);
    const { rows: dias } = await pool.query(`select exception_date::text as d from calendar_availability_exceptions where organization_id = $1`, [ORG]);
    expect(dias).toEqual([{ d: "2026-11-20" }]);
  });
});

describe("as recusas: não escrevem nada", () => {
  const recusa = async (v: Parameters<typeof reprocessar>[0], motivo: RegExp) => {
    const antes = await jobs();
    const r = reprocessar({ ...v, aplicar: true });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(motivo);
    expect(await jobs()).toEqual(antes);
  };

  it("relato já conferido", async () => {
    await pool.query(`update agenda_relatos set estado = 'conferido', conferido_em = now() where id = $1`, [RELATO]);
    await recusa({ job: JOB_MORTO }, /Recusado: o relato está "conferido"/);
  });

  it("organização errada (a mensagem é de outra): não acha nada", async () => {
    await recusa({ org: OUTRA_ORG, msg: MSG_SIM }, /Recusado: a mensagem .* não existe nesta organização/);
    await recusa({ org: OUTRA_ORG, job: JOB_MORTO }, /Recusado: o job .* não é um turno da secretaria nesta organização/);
  });

  it("ela respondeu mais de 12 h depois do resumo: venceu de verdade", async () => {
    await pool.query(`update messages set sent_at = $2 where id = $1`, [MSG_SIM, t(13 * 60)]);
    await recusa({ msg: MSG_SIM }, /Recusado: ela respondeu .* depois do resumo \(mais de 12 h\)/);
  });

  it("depois do 'sim' houve resposta do agente (não automática): o turno não leria o 'sim'", async () => {
    await saidaDoAgente(t(9));
    await recusa({ msg: MSG_SIM }, /Recusado: depois dessa mensagem já houve resposta nossa/);
  });

  it("há um resumo MAIS NOVO dela", async () => {
    await pool.query(
      `insert into agenda_relatos (organization_id, contact_id, texto, lido, janela_de, janela_ate, estado, created_at)
       values ($1, $2, 'novo', '{}'::jsonb, '2026-11-19', '2026-11-19', 'lido', $3)`,
      [ORG, SECRETARIA, t(200)],
    );
    await recusa({ relato: RELATO, msg: MSG_SIM }, /Recusado: há um resumo MAIS NOVO/);
  });

  it("sem nenhum id: recusa com a frase do que informar", async () => {
    await recusa({}, /Recusado: informe a mensagem/);
  });
});
