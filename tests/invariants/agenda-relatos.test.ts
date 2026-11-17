import { execFileSync } from "node:child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * O RELATO DA SECRETARIA no banco — migration 0228.
 *
 * Três coisas que só o banco pode provar:
 *
 *  1. As restrições: estado fechado, janela coerente, "conferido" sempre com carimbo, e a mesma mensagem nunca
 *     virando dois relatos.
 *  2. O isolamento: o relato tem NOME DE PACIENTE. Lê atendente ou mais, da própria organização; ninguém de fora, e
 *     nenhum usuário grava (só o backend, com service role).
 *  3. Que o compromisso nascido de um relato NÃO vai ao Google Agenda: `needs_google_push` é uma coluna gerada, e o
 *     aplicador carimba `google_synced_at` para ela ficar falsa. Sem esta prova o nome do paciente iria para a
 *     agenda do dentista.
 *
 * `set role authenticated` + `request.jwt.claims` é o caminho da produção; como `postgres` (rolbypassrls) a RLS não
 * mediria nada.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function comoUsuario(userId: string, consulta: string): string {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${consulta}
  `);
  return out.split("\n").pop() ?? "";
}

const numeroComo = (userId: string, consulta: string): number => {
  const ultima = comoUsuario(userId, consulta);
  if (!/^-?\d+$/.test(ultima)) throw new Error(`saída inesperada: ${ultima}`);
  return Number(ultima);
};

const ORG_A = "ffffffff-0000-4000-8000-00000000000a";
const ORG_B = "ffffffff-0000-4000-8000-00000000000b";
const MANAGER_A = "ffffffff-1111-4000-8000-00000000000a";
const AGENT_A = "ffffffff-1111-4000-8000-00000000000c";
const VIEWER_A = "ffffffff-1111-4000-8000-00000000000d";
const MANAGER_B = "ffffffff-1111-4000-8000-00000000000b";
const RELATO_A = "ffffffff-2222-4000-8000-00000000000a";
const RELATO_B = "ffffffff-2222-4000-8000-00000000000b";

const novoRelato = (id: string, org: string, extra = "") =>
  `insert into public.agenda_relatos (id, organization_id, texto, lido, janela_de, janela_ate ${extra ? `, ${extra.split("|")[0]}` : ""})
   values ('${id}', '${org}', 'hoje 14h Maria', '{"marcados":[]}'::jsonb, '2026-11-18', '2026-11-18' ${extra ? `, ${extra.split("|")[1]}` : ""})
   on conflict (id) do nothing;`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'rel-mgr-a@invariant.test'),
      ('${AGENT_A}',   'rel-agent-a@invariant.test'),
      ('${VIEWER_A}',  'rel-viewer-a@invariant.test'),
      ('${MANAGER_B}', 'rel-mgr-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'rel-inv-a', 'Relato Invariant A', 'Relato A'),
      ('${ORG_B}', 'rel-inv-b', 'Relato Invariant B', 'Relato B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${VIEWER_A}',  '${ORG_A}', 'viewer',  now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
  `);
  sql(novoRelato(RELATO_A, ORG_A));
  sql(novoRelato(RELATO_B, ORG_B));
});

beforeEach(() => {
  sql(`delete from public.agenda_relatos where id not in ('${RELATO_A}', '${RELATO_B}');`);
});

describe("0228: agenda_relatos — as restrições", () => {
  it("o estado é fechado: só lido, conferido, corrigido e descartado", () => {
    for (const estado of ["aprovado", "Lido", ""]) {
      expect(() =>
        sql(`insert into public.agenda_relatos (organization_id, texto, lido, janela_de, janela_ate, estado)
             values ('${ORG_A}', 't', '{}'::jsonb, '2026-11-18', '2026-11-18', '${estado}');`),
      ).toThrow();
    }
  });

  it("a janela não pode terminar antes de começar", () => {
    expect(() =>
      sql(`insert into public.agenda_relatos (organization_id, texto, lido, janela_de, janela_ate)
           values ('${ORG_A}', 't', '{}'::jsonb, '2026-11-20', '2026-11-18');`),
    ).toThrow();
  });

  it("'conferido' SEM carimbo é recusado (a agenda pareceria fresca para sempre); com carimbo, passa", () => {
    expect(() =>
      sql(`insert into public.agenda_relatos (organization_id, texto, lido, janela_de, janela_ate, estado)
           values ('${ORG_A}', 't', '{}'::jsonb, '2026-11-18', '2026-11-18', 'conferido');`),
    ).toThrow();
    expect(() =>
      sql(`insert into public.agenda_relatos (organization_id, texto, lido, janela_de, janela_ate, estado, conferido_em)
           values ('${ORG_A}', 't', '{}'::jsonb, '2026-11-18', '2026-11-18', 'conferido', now());`),
    ).not.toThrow();
  });

  it("a MESMA mensagem não vira dois relatos na mesma organização", () => {
    const contato = "ffffffff-3333-4000-8000-00000000000a";
    const conversa = "ffffffff-4444-4000-8000-00000000000a";
    const mensagem = "ffffffff-4444-4000-8000-00000000000b";
    // Preparação SEM try/catch: se o esquema de mensagens mudar, este teste tem de falhar alto, não passar vazio.
    const sessao = "ffffffff-6666-4000-8000-00000000000a";
    sql(`
      insert into public.contacts (id, organization_id, display_name)
        values ('${contato}', '${ORG_A}', 'Secretaria') on conflict (id) do nothing;
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
        values ('${sessao}', '${ORG_A}', 'relato-inv', '\\x00', 'WORKING') on conflict (id) do nothing;
      insert into public.conversations (id, organization_id, contact_id, channel_session_id)
        values ('${conversa}', '${ORG_A}', '${contato}', '${sessao}') on conflict (id) do nothing;
      insert into public.messages (id, organization_id, conversation_id, contact_id, channel_session_id, direction, type, body)
        values ('${mensagem}', '${ORG_A}', '${conversa}', '${contato}', '${sessao}', 'inbound', 'text', 'oi')
        on conflict (id) do nothing;
    `);
    const registrar = () =>
      sql(`insert into public.agenda_relatos (organization_id, message_id, texto, lido, janela_de, janela_ate)
           values ('${ORG_A}', '${mensagem}', 't', '{}'::jsonb, '2026-11-18', '2026-11-18');`);
    expect(registrar).not.toThrow();
    expect(registrar).toThrow(/agenda_relatos_mensagem_key|duplicate/);
  });

  it("o índice único por (organização, mensagem) existe e é parcial (várias linhas sem mensagem convivem)", () => {
    const def = sql(`select indexdef from pg_indexes where indexname = 'agenda_relatos_mensagem_key';`);
    expect(def).toMatch(/UNIQUE/i);
    expect(def).toMatch(/organization_id, message_id/);
    expect(def).toMatch(/WHERE \(message_id IS NOT NULL\)/);
    sql(novoRelato("ffffffff-2222-4000-8000-0000000000a1", ORG_A));
    sql(novoRelato("ffffffff-2222-4000-8000-0000000000a2", ORG_A));
    sql(`delete from public.agenda_relatos where id in ('ffffffff-2222-4000-8000-0000000000a1','ffffffff-2222-4000-8000-0000000000a2');`);
  });
});

describe("0228: agenda_relatos — quem lê e quem escreve", () => {
  it("atendente e gerente leem os relatos da PRÓPRIA organização", () => {
    expect(numeroComo(AGENT_A, `select count(*) from public.agenda_relatos where organization_id = '${ORG_A}';`)).toBe(1);
    expect(numeroComo(MANAGER_A, `select count(*) from public.agenda_relatos where organization_id = '${ORG_A}';`)).toBe(1);
  });

  it("o visualizador NÃO lê (o relato tem nome de paciente)", () => {
    expect(numeroComo(VIEWER_A, `select count(*) from public.agenda_relatos;`)).toBe(0);
  });

  it("ninguém lê os relatos da organização vizinha", () => {
    expect(numeroComo(AGENT_A, `select count(*) from public.agenda_relatos where organization_id = '${ORG_B}';`)).toBe(0);
    expect(numeroComo(MANAGER_B, `select count(*) from public.agenda_relatos where organization_id = '${ORG_A}';`)).toBe(0);
    expect(numeroComo(MANAGER_B, `select count(*) from public.agenda_relatos where organization_id = '${ORG_B}';`)).toBe(1);
  });

  it("NENHUM usuário grava: nem o gerente insere, atualiza ou apaga (só o backend, com service role)", () => {
    const comoGerente = (consulta: string) =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
        ${consulta}
      `);
    expect(() =>
      comoGerente(`insert into public.agenda_relatos (organization_id, texto, lido, janela_de, janela_ate)
                   values ('${ORG_A}', 't', '{}'::jsonb, '2026-11-18', '2026-11-18');`),
    ).toThrow();
    // Update e delete sem policy não dão erro: afetam ZERO linhas. O que se prova é que o relato continua igual.
    comoGerente(`update public.agenda_relatos set estado = 'descartado' where id = '${RELATO_A}';`);
    comoGerente(`delete from public.agenda_relatos where id = '${RELATO_A}';`);
    expect(sql(`select estado || '/' || count(*) over () from public.agenda_relatos where id = '${RELATO_A}';`)).toBe("lido/1");
  });
});

describe("0228: o compromisso nascido de um relato", () => {
  const COMPROMISSO = "ffffffff-5555-4000-8000-00000000000a";

  beforeEach(() => {
    sql(`delete from public.calendar_appointments where id = '${COMPROMISSO}';`);
  });

  const inserir = (extra: string) =>
    sql(`insert into public.calendar_appointments
           (id, organization_id, title, starts_at, ends_at, owner_user_id, origem_relato_id, created_by_kind, source ${extra ? ", google_synced_at" : ""})
         values ('${COMPROMISSO}', '${ORG_A}', 'Maria', '2026-11-18T17:00:00Z', '2026-11-18T17:30:00Z',
                 '${MANAGER_A}', '${RELATO_A}', 'ai', 'mcp' ${extra ? ", now()" : ""});`);
  const precisaIrAoGoogle = () =>
    sql(`select needs_google_push::text from public.calendar_appointments where id = '${COMPROMISSO}';`);

  it("com `google_synced_at` carimbado (o que o aplicador faz), NÃO vai ao Google Agenda", () => {
    inserir("carimbado");
    expect(precisaIrAoGoogle()).toBe("false");
  });

  it("sem o carimbo iria — é a diferença que o aplicador existe para fechar", () => {
    inserir("");
    expect(precisaIrAoGoogle()).toBe("true");
  });

  it("apagar o relato NÃO apaga o compromisso (set null): a agenda nunca perde horário por limpeza de trilha", () => {
    inserir("carimbado");
    const relatoTemporario = "ffffffff-2222-4000-8000-0000000000c1";
    sql(novoRelato(relatoTemporario, ORG_A));
    sql(`update public.calendar_appointments set origem_relato_id = '${relatoTemporario}' where id = '${COMPROMISSO}';`);
    sql(`delete from public.agenda_relatos where id = '${relatoTemporario}';`);
    expect(sql(`select coalesce(origem_relato_id::text, 'nulo') from public.calendar_appointments where id = '${COMPROMISSO}';`)).toBe("nulo");
  });

  it("o compromisso do relato não precisa de contato nem de tipo (é uma hora tomada, não consulta de paciente)", () => {
    inserir("carimbado");
    expect(
      sql(`select (contact_id is null)::text || '/' || (event_type_id is null)::text from public.calendar_appointments where id = '${COMPROMISSO}';`),
    ).toBe("true/true");
  });
});
