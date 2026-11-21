import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { logger } from "@/lib/logger";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * O ESPELHO DE RELATO NUNCA VAI AO GOOGLE AGENDA — nem por um UPDATE depois.
 *
 * ═══ O que é o espelho ═══════════════════════════════════════════════════════
 * `aplicarRelato` (lib/agenda/secretaria/aplicar.ts) grava na agenda o que a
 * secretaria contou pelo WhatsApp: um compromisso com `origem_relato_id`, cujo
 * `title` é o NOME DO PACIENTE e que não tem contato. É uma hora tomada, não um
 * compromisso para o calendário pessoal do dentista.
 *
 * ═══ A proteção que já existia, e o furo ═════════════════════════════════════
 * O INSERT nasce com `google_synced_at` preenchido, e o trigger
 * `fn_carimbar_ida_ao_google` o troca por `now()`: `needs_google_push` nasce
 * FALSO. Só que a coluna é "mudou depois da última ida" (`updated_at >
 * google_synced_at`), então QUALQUER update posterior a religa:
 *   - editar o compromisso pela tela do CRM (`title`, `description`...);
 *   - o CANCELAMENTO do próprio `aplicarRelato`, que não carimba nada.
 * Com `needs_google_push = true` o cron `agenda-google-push` escolheria a linha
 * e, com uma conexão Google saudável, publicaria o nome do paciente no
 * calendário do dentista.
 *
 * ═══ O que prende isto ═══════════════════════════════════════════════════════
 * Roda o HANDLER REAL do cron contra Postgres REAL (adaptador
 * `pg-como-supabase`) e contra o `escrita.ts` REAL, com um `fetch` falso no
 * lugar do Google — então o que se mede é "saiu alguma chamada ao Google?", que
 * é a pergunta de privacidade, e não "o código chamou tal função".
 *
 * Fica de fora, de propósito: `apenasDeMembrosAtivos` (usa `.in`, que o
 * adaptador não implementa; é coberto à parte) e a decifragem do token (a
 * conexão tem um token qualquer e `decryptWebhookSecret` devolve um valor fixo).
 * Fixtures sintéticas: nenhum nome ou id é de gente real.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const retido = vi.hoisted(() => ({
  db: null as unknown,
  /** Quando ligado, a consulta do cron IGNORA `.is(...)`: simula quem reintroduz a query sem o filtro. */
  ignorarFiltroDeNulo: false,
  /** Quando ligado, o UPDATE que anota a ida (traz `google_synced_at`) volta com erro, como num banco que recusa. */
  falharAnotacaoDaIda: false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const db = retido.db as { from: (t: string) => { select: (c: string) => Record<string, unknown> } };
    return {
      ...db,
      from: (tabela: string) => {
        const t = db.from(tabela);
        if (tabela !== "calendar_appointments") return t;
        return {
          ...t,
          update: (patch: Record<string, unknown>) =>
            retido.falharAnotacaoDaIda && "google_synced_at" in patch
              ? {
                  eq: () => ({
                    then: (r: (v: unknown) => unknown) =>
                      r({ data: null, error: { message: "falha simulada ao gravar", code: "XX000" } }),
                  }),
                }
              : (t as unknown as { update: (p: unknown) => unknown }).update(patch),
          select: (colunas: string) => {
            const consulta = t.select(colunas);
            if (retido.ignorarFiltroDeNulo) consulta.is = () => consulta;
            return consulta;
          },
        };
      },
    };
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => "token-de-teste") }));
vi.mock("@/lib/agenda/google/membros", () => ({
  apenasDeMembrosAtivos: vi.fn(async (_admin: unknown, linhas: unknown[]) => [...linhas]),
}));

process.env.INTERNAL_CRON_SECRET = "segredo-do-cron-de-teste";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
retido.db = pgComoSupabase(pool);

const ORG = "e5e5a000-0000-4000-8000-000000000001";
const DONO = "e5e5a000-0000-4000-8000-000000000002";
const RELATO = "e5e5a000-0000-4000-8000-000000000003";
const CALENDARIO = "dentista@clinica-sintetica.test";

const id = (n: number) => `e5e5a000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;

interface ChamadaAoGoogle {
  metodo: string;
  url: string;
}
let chamadas: ChamadaAoGoogle[] = [];
/** O que o Google "responde" a cada verbo; os testes trocam o que precisam. */
let respostaDoGoogle: (metodo: string) => Response;

function respostaPadrao(metodo: string): Response {
  if (metodo === "DELETE") return new Response(null, { status: 204 });
  return new Response(JSON.stringify({ id: "evento-do-google", sequence: 0 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function sql<T extends Record<string, unknown>>(texto: string, valores: unknown[] = []): Promise<T[]> {
  return (await pool.query(texto, valores)).rows as T[];
}

/** Como `aplicarRelato` cria: com `google_synced_at` preenchido, `origem_relato_id` e sem contato. */
async function criarEspelho(n: number, nome = "Paciente Sintetico"): Promise<string> {
  await sql(
    `insert into calendar_appointments
       (id, organization_id, owner_user_id, title, starts_at, ends_at, time_zone, status,
        created_by_kind, source, origem_relato_id, google_synced_at)
     values ($1, $2, $3, $4, '2030-05-01T13:00:00Z'::timestamptz + make_interval(mins => $5::int),
             '2030-05-01T13:30:00Z'::timestamptz + make_interval(mins => $5::int),
             'America/Sao_Paulo', 'confirmed', 'ai', 'mcp', $6, now())`,
    [id(n), ORG, DONO, nome, n, RELATO],
  );
  return id(n);
}

/** Um compromisso comum: nunca foi ao Google (`google_synced_at` nulo), sem origem de relato. */
async function criarComum(n: number, extra: { status?: string; google_event_id?: string | null } = {}): Promise<string> {
  await sql(
    `insert into calendar_appointments
       (id, organization_id, owner_user_id, title, starts_at, ends_at, time_zone, status, google_event_id, cancelled_at)
     values ($1, $2, $3, 'Consulta de rotina', '2030-06-01T13:00:00Z'::timestamptz + make_interval(mins => $4::int),
             '2030-06-01T13:30:00Z'::timestamptz + make_interval(mins => $4::int),
             'America/Sao_Paulo', $5, $6, case when $5 = 'cancelled' then now() end)`,
    [id(n), ORG, DONO, n, extra.status ?? "confirmed", extra.google_event_id ?? null],
  );
  return id(n);
}

/** O que a tela do CRM faz ao editar o compromisso. */
async function editarPelaTela(idAgendamento: string): Promise<void> {
  await sql(`update calendar_appointments set title = 'Titulo editado', description = 'Observacao nova' where id = $1`, [
    idAgendamento,
  ]);
}

/** O que `aplicarRelato` faz ao cancelar: status + motivo, SEM carimbar `google_synced_at`. */
async function cancelarComoOAplicador(idAgendamento: string): Promise<void> {
  await sql(
    `update calendar_appointments
        set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Relato da secretaria'
      where id = $1`,
    [idAgendamento],
  );
}

async function precisaIr(idAgendamento: string): Promise<boolean> {
  const [linha] = await sql<{ n: boolean }>(`select needs_google_push as n from calendar_appointments where id = $1`, [
    idAgendamento,
  ]);
  return linha?.n === true;
}

async function rodarOCron(): Promise<Record<string, number>> {
  const { GET } = await import("@/app/api/v1/cron/agenda-google-push/route");
  const { NextRequest } = await import("next/server");
  const r = await GET(
    new NextRequest("https://crm.exemplo/api/v1/cron/agenda-google-push", {
      headers: { authorization: "Bearer segredo-do-cron-de-teste" },
    }),
  );
  expect(r.status).toBe(200);
  return ((await r.json()) as { data: Record<string, number> }).data;
}

beforeAll(async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'dentista-sintetico@invariant.test') on conflict (id) do nothing`, [DONO]);
  await sql(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-espelho-google', 'Clinica Sintetica LTDA', 'Clinica Sintetica') on conflict (id) do nothing`,
    [ORG],
  );
  await sql(
    `insert into user_organizations (user_id, organization_id, role, accepted_at)
     values ($1, $2, 'admin', now()) on conflict do nothing`,
    [DONO, ORG],
  );
  await sql(
    `insert into agenda_relatos (id, organization_id, texto, lido, janela_de, janela_ate)
     values ($1, $2, 'relato sintetico', '{"marcados":[]}'::jsonb, '2030-05-01', '2030-05-01') on conflict (id) do nothing`,
    [RELATO, ORG],
  );
  // A conexão SAUDÁVEL é o que faz o vazamento possível: sem ela o cron só
  // contaria `semConexao`, e todos os casos abaixo passariam sem provar nada.
  await sql(
    `insert into calendar_connections
       (organization_id, user_id, provider, account_email, oauth_access_token_encrypted, status)
     values ($1, $2, 'google_calendar', $3, '\\x01'::bytea, 'healthy')`,
    [ORG, DONO, CALENDARIO],
  );
});

afterAll(async () => {
  await sql(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

beforeEach(async () => {
  await sql(`delete from calendar_appointments where organization_id = $1`, [ORG]);
  chamadas = [];
  respostaDoGoogle = respostaPadrao;
  retido.ignorarFiltroDeNulo = false;
  retido.falharAnotacaoDaIda = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const metodo = init?.method ?? "GET";
      chamadas.push({ metodo, url: String(url) });
      return respostaDoGoogle(metodo);
    }),
  );
});

describe("CONTROLE DO INSTRUMENTO: o cron publica quando deve", () => {
  it("compromisso comum pendente É publicado — sem isto, 'nada saiu' abaixo não prova filtro nenhum", async () => {
    const comum = await criarComum(1);
    expect(await precisaIr(comum)).toBe(true);

    const resumo = await rodarOCron();

    expect(chamadas.map((c) => c.metodo)).toEqual(["POST"]);
    expect(resumo).toMatchObject({ candidatos: 1, publicados: 1, falhas: 0, semConexao: 0 });
    const [linha] = await sql<{ google_event_id: string | null; n: boolean }>(
      `select google_event_id, needs_google_push as n from calendar_appointments where id = $1`,
      [comum],
    );
    expect(linha?.google_event_id).toBe("evento-do-google");
    expect(linha?.n, "depois de publicar a linha sai da fila").toBe(false);
  });

  it("compromisso comum CANCELADO que já estava no Google É apagado de lá", async () => {
    const comum = await criarComum(2, { status: "cancelled", google_event_id: "evento-antigo" });

    const resumo = await rodarOCron();

    expect(chamadas.map((c) => c.metodo)).toEqual(["DELETE"]);
    expect(resumo).toMatchObject({ candidatos: 1, apagados: 1, falhas: 0 });
    const [linha] = await sql<{ google_event_id: string | null; n: boolean }>(
      `select google_event_id, needs_google_push as n from calendar_appointments where id = $1`,
      [comum],
    );
    expect(linha?.google_event_id).toBeNull();
    expect(linha?.n, "apagou lá mas a linha ficou na fila: o DELETE sairia a cada rodada").toBe(false);

    chamadas = [];
    expect(await rodarOCron()).toMatchObject({ candidatos: 0 });
    expect(chamadas, "a segunda rodada apagou de novo").toEqual([]);
  });
});

describe("quando o CRM não consegue anotar a ida, o cron conta e registra — não engole", () => {
  it("UPDATE final com erro: falhas = 1, nada de publicados, log sem o título do compromisso", async () => {
    const avisos = vi.spyOn(logger, "warn");
    const comum = await criarComum(70);
    await sql(`update calendar_appointments set title = 'Titulo Sensivel Sintetico' where id = $1`, [comum]);
    retido.falharAnotacaoDaIda = true;

    const resumo = await rodarOCron();

    expect(chamadas.map((c) => c.metodo)).toEqual(["POST"]);
    expect(resumo).toMatchObject({ candidatos: 1, publicados: 0, apagados: 0, falhas: 1 });
    const registro = avisos.mock.calls.find((c) => String(c[0]).includes("não gravou o resultado"));
    expect(registro, "o erro de gravação não foi registrado no log").toBeDefined();
    expect(JSON.stringify(registro)).not.toContain("Titulo Sensivel Sintetico");
    expect(JSON.stringify(registro)).toContain("falha simulada ao gravar");
    expect(await precisaIr(comum), "sem anotar, a linha continua na fila para a próxima rodada").toBe(true);
    avisos.mockRestore();
  });

  it("CONTROLE: sem a falha simulada, o mesmo caso conta publicado e sai da fila", async () => {
    const comum = await criarComum(71);
    const resumo = await rodarOCron();
    expect(resumo).toMatchObject({ publicados: 1, falhas: 0 });
    expect(await precisaIr(comum)).toBe(false);
  });
});

describe("o espelho de relato (nome de paciente) NÃO sai para o Google", () => {
  it("(premissa) o espelho nasce fora da fila — a proteção do INSERT continua de pé", async () => {
    const espelho = await criarEspelho(10);
    expect(await precisaIr(espelho)).toBe(false);
    await rodarOCron();
    expect(chamadas).toEqual([]);
  });

  it("(a) EDITADO pela tela do CRM, não é publicado — mesmo voltando para a fila", async () => {
    const espelho = await criarEspelho(11, "Paciente Que Nao Pode Vazar");
    await editarPelaTela(espelho);
    // A premissa do defeito: o update religou `needs_google_push`. Se isto não
    // fosse verdade, o caso passaria sem o filtro e não provaria nada.
    expect(await precisaIr(espelho), "o update devia ter religado needs_google_push").toBe(true);

    const resumo = await rodarOCron();

    expect(chamadas, "saiu chamada ao Google com o nome de um paciente").toEqual([]);
    // `espelhosRecusados: 0` é o que separa o FILTRO da consulta da recusa do loop: se só a
    // recusa estivesse de pé, o espelho teria sido lido e recusado (1), não excluído na leitura.
    expect(resumo).toMatchObject({ candidatos: 0, publicados: 0, apagados: 0, falhas: 0, espelhosRecusados: 0 });
  });

  it("(b) CANCELADO como o aplicador faz, não é candidato e nenhum DELETE sai", async () => {
    const espelho = await criarEspelho(12);
    await cancelarComoOAplicador(espelho);
    expect(await precisaIr(espelho), "o cancelamento devia ter religado needs_google_push").toBe(true);

    const resumo = await rodarOCron();

    expect(chamadas, "saiu chamada ao Google por causa de um espelho cancelado").toEqual([]);
    expect(resumo).toMatchObject({ candidatos: 0, publicados: 0, apagados: 0, falhas: 0, espelhosRecusados: 0 });
    const [linha] = await sql<{ google_sync_error: string | null }>(
      `select google_sync_error from calendar_appointments where id = $1`,
      [espelho],
    );
    expect(linha?.google_sync_error, "o cron não pode nem escrever erro na linha do espelho").toBeNull();
  });

  it("(c)+(d) misturados: só o comum é publicado, e `candidatos` conta sem os espelhos", async () => {
    const editado = await criarEspelho(13);
    const cancelado = await criarEspelho(14);
    await criarEspelho(15); // intacto, fora da fila
    await editarPelaTela(editado);
    await cancelarComoOAplicador(cancelado);
    const comum = await criarComum(16);

    const resumo = await rodarOCron();

    expect(chamadas.map((c) => c.metodo)).toEqual(["POST"]);
    expect(chamadas[0]!.url).toContain(encodeURIComponent(CALENDARIO));
    expect(resumo).toMatchObject({ candidatos: 1, publicados: 1, apagados: 0, falhas: 0, espelhosRecusados: 0 });
    const [linha] = await sql<{ google_event_id: string | null }>(
      `select google_event_id from calendar_appointments where id = $1`,
      [comum],
    );
    expect(linha?.google_event_id).toBe("evento-do-google");
  });

  it("(g) espelhos não gastam o teto de 50 por rodada: o comum atrás deles ainda é publicado", async () => {
    // O cron lê por `starts_at` crescente e limita a 50. Se o filtro fosse
    // aplicado DEPOIS da leitura, 50 espelhos mais cedo ocupariam a rodada
    // inteira e o compromisso real ficaria esperando para sempre.
    for (let n = 20; n < 20 + 51; n++) {
      const e = await criarEspelho(n);
      await editarPelaTela(e);
    }
    const comum = await criarComum(90);

    const resumo = await rodarOCron();

    expect(chamadas.map((c) => c.metodo)).toEqual(["POST"]);
    expect(resumo).toMatchObject({ candidatos: 1, publicados: 1 });
    const [linha] = await sql<{ google_event_id: string | null }>(
      `select google_event_id from calendar_appointments where id = $1`,
      [comum],
    );
    expect(linha?.google_event_id).toBe("evento-do-google");
  });
});

describe("DEFESA EM PROFUNDIDADE: se um espelho chegar ao loop por outro caminho, o loop recusa", () => {
  // `ignorarFiltroDeNulo` simula o dia em que alguém reescrever a consulta do
  // cron sem o `.is("origem_relato_id", null)`. O que protege o paciente nesse
  // dia é a recusa na hora de publicar/apagar, e é ela que estes casos medem.
  it("espelho editado que chega ao loop NÃO é publicado, e a recusa é contada", async () => {
    const espelho = await criarEspelho(11, "Paciente Que Nao Pode Vazar");
    await editarPelaTela(espelho);
    retido.ignorarFiltroDeNulo = true;

    const resumo = await rodarOCron();

    expect(chamadas, "o espelho chegou ao loop e foi publicado").toEqual([]);
    expect(resumo).toMatchObject({ publicados: 0, apagados: 0, falhas: 0, espelhosRecusados: 1 });
  });

  it("espelho cancelado que chega ao loop NÃO dispara DELETE", async () => {
    const espelho = await criarEspelho(12);
    await cancelarComoOAplicador(espelho);
    retido.ignorarFiltroDeNulo = true;

    const resumo = await rodarOCron();

    expect(chamadas).toEqual([]);
    expect(resumo).toMatchObject({ publicados: 0, apagados: 0, falhas: 0, espelhosRecusados: 1 });
  });

  it("CONTROLE: com o filtro quebrado, o comum ao lado do espelho continua sendo publicado", async () => {
    const espelho = await criarEspelho(13);
    await editarPelaTela(espelho);
    await criarComum(14);
    retido.ignorarFiltroDeNulo = true;

    const resumo = await rodarOCron();

    expect(chamadas.map((c) => c.metodo)).toEqual(["POST"]);
    expect(resumo).toMatchObject({ candidatos: 1, publicados: 1, espelhosRecusados: 1 });
  });
});

describe("404/410 ao apagar é SUCESSO e não vira laço", () => {
  it("cancelado comum SEM google_event_id, Google devolve 404: sai da fila, sem erro gravado, e não volta", async () => {
    const comum = await criarComum(60, { status: "cancelled", google_event_id: null });
    respostaDoGoogle = () => new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });

    const primeira = await rodarOCron();
    expect(primeira).toMatchObject({ candidatos: 1, apagados: 1, falhas: 0 });
    const [linha] = await sql<{ e: string | null; n: boolean; synced: string | null }>(
      `select google_sync_error as e, needs_google_push as n, google_synced_at::text as synced
         from calendar_appointments where id = $1`,
      [comum],
    );
    expect(linha?.e).toBeNull();
    expect(linha?.n, "ficou na fila: o 404 estaria virando laço").toBe(false);
    expect(linha?.synced).not.toBeNull();

    chamadas = [];
    const segunda = await rodarOCron();
    expect(segunda).toMatchObject({ candidatos: 0 });
    expect(chamadas).toEqual([]);
  });
});
