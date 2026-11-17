import { execFileSync } from "node:child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * AS PERGUNTAS DIÁRIAS À SECRETARIA no banco — migration 0230.
 *
 * O que só o banco prova:
 *
 *  1. As restrições: horário no formato HH:MM (a pergunta de "8:30" sem zero à esquerda é recusada, não gravada
 *     torta), estado fechado, e a MESMA pergunta (organização + contato + dia + horário) nunca duas vezes — que é o
 *     que faz o cron de 5 em 5 minutos ser idempotente.
 *  2. O isolamento: lê atendente ou mais, da própria organização; nenhum usuário grava.
 *  3. A Central de avisos aceita o aviso `agenda_sem_resposta` e continua recusando tipo desconhecido.
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

const ORG_A = "ffffffff-0000-4000-8000-0000000000a1";
const ORG_B = "ffffffff-0000-4000-8000-0000000000b1";
const MANAGER_A = "ffffffff-1111-4000-8000-0000000000a1";
const AGENT_A = "ffffffff-1111-4000-8000-0000000000c1";
const VIEWER_A = "ffffffff-1111-4000-8000-0000000000d1";
const MANAGER_B = "ffffffff-1111-4000-8000-0000000000b1";
const CONTATO_A = "ffffffff-3333-4000-8000-0000000000a1";
const CONTATO_B = "ffffffff-3333-4000-8000-0000000000b1";

const pergunta = (org: string, contato: string, dia: string, horario: string, extra = "") =>
  `insert into public.agenda_perguntas (organization_id, contact_id, dia, horario ${extra ? ", estado" : ""})
   values ('${org}', '${contato}', '${dia}', '${horario}' ${extra ? `, '${extra}'` : ""});`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'perg-mgr-a@invariant.test'),
      ('${AGENT_A}',   'perg-agent-a@invariant.test'),
      ('${VIEWER_A}',  'perg-viewer-a@invariant.test'),
      ('${MANAGER_B}', 'perg-mgr-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'perg-inv-a', 'Perguntas Invariant A', 'Perguntas A'),
      ('${ORG_B}', 'perg-inv-b', 'Perguntas Invariant B', 'Perguntas B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${VIEWER_A}',  '${ORG_A}', 'viewer',  now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${ORG_A}', 'Secretaria A'),
      ('${CONTATO_B}', '${ORG_B}', 'Secretaria B')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => {
  sql(`delete from public.agenda_perguntas where organization_id in ('${ORG_A}', '${ORG_B}');`);
  sql(pergunta(ORG_A, CONTATO_A, "2026-11-18", "08:30"));
  sql(pergunta(ORG_B, CONTATO_B, "2026-11-18", "08:30"));
});

describe("0230: agenda_perguntas — as restrições", () => {
  it("o horário é HH:MM com zero à esquerda e hora válida", () => {
    for (const horario of ["8:30", "24:00", "12:60", "meio-dia", ""]) {
      expect(() => sql(pergunta(ORG_A, CONTATO_A, "2026-11-19", horario))).toThrow();
    }
    for (const horario of ["00:00", "08:30", "23:59"]) {
      expect(() => sql(pergunta(ORG_A, CONTATO_A, "2026-11-19", horario))).not.toThrow();
    }
  });

  it("o estado é fechado: pedida, dispensada ou sem_conversa", () => {
    for (const estado of ["enviada", "Pedida", "respondida"]) {
      expect(() => sql(pergunta(ORG_A, CONTATO_A, "2026-11-20", "14:00", estado))).toThrow();
    }
    for (const estado of ["pedida", "dispensada", "sem_conversa"]) {
      expect(() => sql(pergunta(ORG_A, CONTATO_A, `2026-11-2${["pedida", "dispensada", "sem_conversa"].indexOf(estado) + 1}`, "14:00", estado))).not.toThrow();
    }
  });

  it("a MESMA pergunta (organização + contato + dia + horário) não entra duas vezes — e ON CONFLICT DO NOTHING a ignora", () => {
    expect(() => sql(pergunta(ORG_A, CONTATO_A, "2026-11-18", "08:30"))).toThrow(/agenda_perguntas_slot_key|duplicate/);
    const out = sql(`
      insert into public.agenda_perguntas (organization_id, contact_id, dia, horario)
        values ('${ORG_A}', '${CONTATO_A}', '2026-11-18', '08:30')
        on conflict (organization_id, contact_id, dia, horario) do nothing
        returning id;
    `);
    // O psql imprime a etiqueta do comando: "INSERT 0 0" = zero linhas gravadas (e nenhum id devolvido).
    expect(out).toBe("INSERT 0 0");
  });

  it("horário diferente no mesmo dia é outra pergunta", () => {
    expect(() => sql(pergunta(ORG_A, CONTATO_A, "2026-11-18", "14:00"))).not.toThrow();
  });

  it("apagar o contato apaga as perguntas dele (é só controle do cron)", () => {
    const efemero = "ffffffff-3333-4000-8000-0000000000e1";
    sql(`insert into public.contacts (id, organization_id, display_name) values ('${efemero}', '${ORG_A}', 'Efêmera') on conflict (id) do nothing;`);
    sql(pergunta(ORG_A, efemero, "2026-11-18", "18:15"));
    sql(`delete from public.contacts where id = '${efemero}';`);
    expect(sql(`select count(*) from public.agenda_perguntas where contact_id = '${efemero}';`)).toBe("0");
  });
});

describe("0230: agenda_perguntas — quem lê e quem escreve", () => {
  it("atendente e gerente leem as perguntas da PRÓPRIA organização", () => {
    expect(numeroComo(AGENT_A, `select count(*) from public.agenda_perguntas where organization_id = '${ORG_A}';`)).toBe(1);
    expect(numeroComo(MANAGER_A, `select count(*) from public.agenda_perguntas where organization_id = '${ORG_A}';`)).toBe(1);
  });

  it("o visualizador NÃO lê", () => {
    expect(numeroComo(VIEWER_A, `select count(*) from public.agenda_perguntas;`)).toBe(0);
  });

  it("ninguém lê as perguntas da organização vizinha", () => {
    expect(numeroComo(AGENT_A, `select count(*) from public.agenda_perguntas where organization_id = '${ORG_B}';`)).toBe(0);
    expect(numeroComo(MANAGER_B, `select count(*) from public.agenda_perguntas where organization_id = '${ORG_A}';`)).toBe(0);
    expect(numeroComo(MANAGER_B, `select count(*) from public.agenda_perguntas where organization_id = '${ORG_B}';`)).toBe(1);
  });

  it("NENHUM usuário grava: nem o gerente insere, atualiza ou apaga", () => {
    const comoGerente = (consulta: string) =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
        ${consulta}
      `);
    expect(() => comoGerente(pergunta(ORG_A, CONTATO_A, "2026-11-25", "08:30"))).toThrow();
    comoGerente(`update public.agenda_perguntas set respondida_em = now() where organization_id = '${ORG_A}';`);
    comoGerente(`delete from public.agenda_perguntas where organization_id = '${ORG_A}';`);
    expect(sql(`select count(*) || '/' || count(respondida_em) from public.agenda_perguntas where organization_id = '${ORG_A}';`)).toBe("1/0");
  });
});

describe("0230: a Central de avisos aceita o aviso da secretaria", () => {
  const inserirAviso = (kind: string) =>
    sql(`insert into public.agent_inbox_items (organization_id, kind, severity, title)
         values ('${ORG_A}', '${kind}', 'warn', 'teste');`);

  it("agenda_sem_resposta entra; tipo inventado continua recusado", () => {
    expect(() => inserirAviso("agenda_sem_resposta")).not.toThrow();
    expect(() => inserirAviso("secretaria_sumiu")).toThrow();
    sql(`delete from public.agent_inbox_items where organization_id = '${ORG_A}' and title = 'teste';`);
  });
});
