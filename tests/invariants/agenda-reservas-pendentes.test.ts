import { execFileSync } from "node:child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * A RESERVA DE HORÁRIO QUE ESPERA A SECRETARIA no banco — migration 0231.
 *
 * O que só o banco prova:
 *
 *  1. Os dois índices únicos PARCIAIS são o que impede a corrida entre duas conversas ao mesmo tempo:
 *     - o mesmo horário do mesmo dono não é segurado por dois pacientes;
 *     - o mesmo paciente não segura dois horários.
 *     Só valem para reserva AGUARDANDO: depois que ela fecha (confirmada, recusada, expirada, cancelada) o horário e o
 *     paciente ficam livres de novo.
 *  2. As restrições: estado fechado, fim depois do início, nome com tamanho sensato.
 *  3. O isolamento: lê atendente ou mais, da própria organização; nenhum usuário grava.
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

const ORG_A = "ffffffff-0000-4000-8000-0000000000f1";
const ORG_B = "ffffffff-0000-4000-8000-0000000000f2";
const MANAGER_A = "ffffffff-1111-4000-8000-0000000000f1";
const AGENT_A = "ffffffff-1111-4000-8000-0000000000f3";
const VIEWER_A = "ffffffff-1111-4000-8000-0000000000f4";
const MANAGER_B = "ffffffff-1111-4000-8000-0000000000f2";
const PACIENTE_1 = "ffffffff-3333-4000-8000-0000000000f1";
const PACIENTE_2 = "ffffffff-3333-4000-8000-0000000000f3";
const PACIENTE_B = "ffffffff-3333-4000-8000-0000000000f2";
const TIPO_A = "ffffffff-4444-4000-8000-0000000000f1";
const TIPO_B = "ffffffff-4444-4000-8000-0000000000f2";

const INICIO_1 = "2030-03-04 14:00:00+00";
const FIM_1 = "2030-03-04 14:30:00+00";
const INICIO_2 = "2030-03-04 15:00:00+00";
const FIM_2 = "2030-03-04 15:30:00+00";

interface Reserva {
  org?: string;
  paciente?: string;
  tipo?: string;
  dono?: string;
  inicio?: string;
  fim?: string;
  nome?: string;
  status?: string;
}

const reserva = (r: Reserva = {}) => {
  const org = r.org ?? ORG_A;
  return `insert into public.agenda_reservas_pendentes
    (organization_id, contact_id, event_type_id, owner_user_id, starts_at, ends_at, nome_paciente, status, expira_em)
    values ('${org}', '${r.paciente ?? PACIENTE_1}', '${r.tipo ?? (org === ORG_A ? TIPO_A : TIPO_B)}',
            '${r.dono ?? MANAGER_A}', '${r.inicio ?? INICIO_1}', '${r.fim ?? FIM_1}',
            '${r.nome ?? "Maria da Silva"}', '${r.status ?? "aguardando_secretaria"}', now() + interval '15 minutes');`;
};

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'resv-mgr-a@invariant.test'),
      ('${AGENT_A}',   'resv-agent-a@invariant.test'),
      ('${VIEWER_A}',  'resv-viewer-a@invariant.test'),
      ('${MANAGER_B}', 'resv-mgr-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'resv-inv-a', 'Reservas Invariant A', 'Reservas A'),
      ('${ORG_B}', 'resv-inv-b', 'Reservas Invariant B', 'Reservas B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${VIEWER_A}',  '${ORG_A}', 'viewer',  now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${PACIENTE_1}', '${ORG_A}', 'Paciente 1'),
      ('${PACIENTE_2}', '${ORG_A}', 'Paciente 2'),
      ('${PACIENTE_B}', '${ORG_B}', 'Paciente B')
      on conflict (id) do nothing;
    insert into public.calendar_event_types (id, organization_id, name, slug) values
      ('${TIPO_A}', '${ORG_A}', 'Avaliação A', 'avaliacao-resv-a'),
      ('${TIPO_B}', '${ORG_B}', 'Avaliação B', 'avaliacao-resv-b')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => {
  sql(`delete from public.agenda_reservas_pendentes where organization_id in ('${ORG_A}', '${ORG_B}');`);
  sql(reserva());
  sql(reserva({ org: ORG_B, paciente: PACIENTE_B, dono: MANAGER_B }));
});

describe("0231: agenda_reservas_pendentes — a corrida entre conversas", () => {
  it("o MESMO horário do mesmo dono não é segurado por dois pacientes", () => {
    expect(() => sql(reserva({ paciente: PACIENTE_2 }))).toThrow(/agenda_reservas_horario_ativo_key|duplicate/);
  });

  it("o MESMO paciente não segura dois horários ao mesmo tempo", () => {
    expect(() => sql(reserva({ inicio: INICIO_2, fim: FIM_2 }))).toThrow(/agenda_reservas_paciente_ativa_key|duplicate/);
  });

  it("outro paciente, em outro horário, segura normalmente", () => {
    expect(() => sql(reserva({ paciente: PACIENTE_2, inicio: INICIO_2, fim: FIM_2 }))).not.toThrow();
  });

  it("o mesmo horário em OUTRA agenda (outro dono) não conflita", () => {
    expect(() => sql(reserva({ paciente: PACIENTE_2, dono: AGENT_A }))).not.toThrow();
  });

  it("fechada a reserva, o horário e o paciente ficam livres (índice parcial: só vale para 'aguardando')", () => {
    sql(`update public.agenda_reservas_pendentes set status = 'recusada' where organization_id = '${ORG_A}';`);
    expect(() => sql(reserva({ paciente: PACIENTE_2 }))).not.toThrow(); // mesmo horário, outro paciente
    expect(() => sql(reserva({ paciente: PACIENTE_1, inicio: INICIO_2, fim: FIM_2 }))).not.toThrow(); // mesmo paciente, outro horário
  });

  it("várias reservas FECHADAS do mesmo horário e paciente convivem (é histórico)", () => {
    sql(`update public.agenda_reservas_pendentes set status = 'expirada' where organization_id = '${ORG_A}';`);
    expect(() => sql(reserva({ status: "cancelada" }))).not.toThrow();
    expect(() => sql(reserva({ status: "confirmada" }))).not.toThrow();
  });
});

describe("0231: agenda_reservas_pendentes — as restrições", () => {
  it("o estado é fechado", () => {
    sql(`update public.agenda_reservas_pendentes set status = 'cancelada' where organization_id = '${ORG_A}';`);
    for (const status of ["pendente", "Confirmada", "aguardando", ""]) {
      expect(() => sql(reserva({ status }))).toThrow();
    }
    for (const status of ["confirmada", "recusada", "expirada", "cancelada"]) {
      expect(() => sql(reserva({ status }))).not.toThrow();
    }
  });

  it("o fim é depois do início", () => {
    sql(`update public.agenda_reservas_pendentes set status = 'cancelada' where organization_id = '${ORG_A}';`);
    expect(() => sql(reserva({ fim: INICIO_1 }))).toThrow();
    expect(() => sql(reserva({ fim: "2030-03-04 13:00:00+00" }))).toThrow();
  });

  it("o nome do paciente tem tamanho sensato (3 a 200 caracteres, sem só espaços)", () => {
    sql(`update public.agenda_reservas_pendentes set status = 'cancelada' where organization_id = '${ORG_A}';`);
    for (const nome of ["", "  ", "Jo", "x".repeat(201)]) {
      expect(() => sql(reserva({ nome, status: "cancelada" }))).toThrow();
    }
    expect(() => sql(reserva({ nome: "Ana", status: "cancelada" }))).not.toThrow();
  });

  it("apagar o paciente apaga as reservas dele", () => {
    const efemero = "ffffffff-3333-4000-8000-0000000000fe";
    sql(`insert into public.contacts (id, organization_id, display_name) values ('${efemero}', '${ORG_A}', 'Efêmero') on conflict (id) do nothing;`);
    sql(reserva({ paciente: efemero, inicio: INICIO_2, fim: FIM_2 }));
    sql(`delete from public.contacts where id = '${efemero}';`);
    expect(sql(`select count(*) from public.agenda_reservas_pendentes where contact_id = '${efemero}';`)).toBe("0");
  });
});

describe("0231: agenda_reservas_pendentes — quem lê e quem escreve", () => {
  it("atendente e gerente leem as reservas da PRÓPRIA organização", () => {
    expect(numeroComo(AGENT_A, `select count(*) from public.agenda_reservas_pendentes where organization_id = '${ORG_A}';`)).toBe(1);
    expect(numeroComo(MANAGER_A, `select count(*) from public.agenda_reservas_pendentes where organization_id = '${ORG_A}';`)).toBe(1);
  });

  it("visualizador não lê (o nome do paciente é dado sensível)", () => {
    expect(numeroComo(VIEWER_A, `select count(*) from public.agenda_reservas_pendentes;`)).toBe(0);
  });

  it("ninguém lê a organização vizinha", () => {
    expect(numeroComo(AGENT_A, `select count(*) from public.agenda_reservas_pendentes where organization_id = '${ORG_B}';`)).toBe(0);
    expect(numeroComo(MANAGER_B, `select count(*) from public.agenda_reservas_pendentes where organization_id = '${ORG_A}';`)).toBe(0);
    expect(numeroComo(MANAGER_B, `select count(*) from public.agenda_reservas_pendentes where organization_id = '${ORG_B}';`)).toBe(1);
  });

  it("nenhum usuário grava: insert é recusado pela RLS", () => {
    const insercao = `
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
      ${reserva({ paciente: PACIENTE_2, inicio: INICIO_2, fim: FIM_2 })}
    `;
    expect(() => sql(insercao)).toThrow(/row-level security|permission denied/);
  });

  it("update e delete feitos por usuário não alteram nada (sem policy)", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
      update public.agenda_reservas_pendentes set status = 'confirmada' where organization_id = '${ORG_A}';
      delete from public.agenda_reservas_pendentes where organization_id = '${ORG_A}';
    `);
    expect(sql(`select count(*) || '/' || count(*) filter (where status = 'aguardando_secretaria') from public.agenda_reservas_pendentes where organization_id = '${ORG_A}';`)).toBe("1/1");
  });
});
