import { execFileSync } from "node:child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * PAPEL INTERNO DO CONTATO (secretaria, marketing) — migration 0227.
 *
 * O marketing consegue disparar campanha e a secretaria alimenta a agenda: o papel é um poder, e quem o define tem
 * de ser gerente ou admin MESMO que alguém fale direto com o banco. Três travas, e este arquivo prova as três:
 *
 *  1. CHECK de valor       — papel desconhecido é recusado pelo banco.
 *  2. CHECK de coerência   — quem tem papel TEM de estar fora do funil (e não volta ao funil sem perder o papel).
 *  3. gatilho de guarda    — sessão de usuário que não é gerente/admin não define papel. Testado como `postgres`
 *                            (que ignora a RLS) com `request.jwt.claims` preenchido: assim só o GATILHO decide, e a
 *                            RLS de `contacts` não mascara a prova.
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

/** Como o postgres (RLS ignorada), mas com a identidade de um usuário nas claims: só o gatilho decide. */
const comoSessaoDe = (userId: string, consulta: string): string =>
  sql(`select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);\n${consulta}`);

const ORG_A = "dddddddd-0000-4000-8000-00000000000a";
const ORG_B = "dddddddd-0000-4000-8000-00000000000b";
const MANAGER_A = "dddddddd-1111-4000-8000-00000000000a";
const AGENT_A = "dddddddd-1111-4000-8000-00000000000c";
const MANAGER_B = "dddddddd-1111-4000-8000-00000000000b";
const ADMIN_A = "dddddddd-1111-4000-8000-00000000000e";
const PESSOA = "dddddddd-2222-4000-8000-00000000000a";

const papelDe = (contato: string) =>
  sql(`select coalesce(papel_interno, '(nenhum)') from public.contacts where id = '${contato}';`);
const reiniciar = () =>
  sql(`update public.contacts set papel_interno = null, fora_do_funil_em = null where id = '${PESSOA}';`);
const marcarForaDoFunil = () =>
  sql(`update public.contacts set fora_do_funil_em = now() where id = '${PESSOA}';`);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'papel-mgr-a@invariant.test'),
      ('${AGENT_A}',   'papel-agent-a@invariant.test'),
      ('${MANAGER_B}', 'papel-mgr-b@invariant.test'),
      ('${ADMIN_A}',   'papel-admin-a@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'papel-inv-a', 'Papel Invariant A', 'Papel A'),
      ('${ORG_B}', 'papel-inv-b', 'Papel Invariant B', 'Papel B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now()),
      ('${ADMIN_A}',   '${ORG_A}', 'admin',   now())
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${PESSOA}', '${ORG_A}', 'Pessoa da Equipe')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => {
  reiniciar();
});

describe("0227: papel_interno — os dois CHECKs", () => {
  it("a coluna existe e o padrão é 'nenhum'", () => {
    expect(papelDe(PESSOA)).toBe("(nenhum)");
  });

  it("papel desconhecido é recusado pelo banco", () => {
    marcarForaDoFunil();
    for (const papel of ["dono", "admin", "Secretaria", ""]) {
      expect(() => sql(`update public.contacts set papel_interno = '${papel}' where id = '${PESSOA}';`)).toThrow();
    }
    expect(papelDe(PESSOA)).toBe("(nenhum)");
  });

  it("os dois papéis válidos são aceitos (contato já fora do funil)", () => {
    marcarForaDoFunil();
    sql(`update public.contacts set papel_interno = 'secretaria' where id = '${PESSOA}';`);
    expect(papelDe(PESSOA)).toBe("secretaria");
    sql(`update public.contacts set papel_interno = 'marketing' where id = '${PESSOA}';`);
    expect(papelDe(PESSOA)).toBe("marketing");
  });

  it("papel em contato que está no funil é recusado (quem tem papel é equipe)", () => {
    expect(() => sql(`update public.contacts set papel_interno = 'secretaria' where id = '${PESSOA}';`)).toThrow();
    expect(papelDe(PESSOA)).toBe("(nenhum)");
  });

  it("não dá para devolver ao funil quem ainda tem papel; tirando o papel antes, dá", () => {
    marcarForaDoFunil();
    sql(`update public.contacts set papel_interno = 'marketing' where id = '${PESSOA}';`);
    expect(() => sql(`update public.contacts set fora_do_funil_em = null where id = '${PESSOA}';`)).toThrow();
    sql(`update public.contacts set papel_interno = null where id = '${PESSOA}';`);
    sql(`update public.contacts set fora_do_funil_em = null where id = '${PESSOA}';`);
    expect(papelDe(PESSOA)).toBe("(nenhum)");
  });
});

describe("0227: papel_interno — o gatilho de guarda (só gerente ou admin define)", () => {
  beforeEach(() => {
    marcarForaDoFunil();
  });

  it("atendente NÃO define papel, nem em contato da própria organização", () => {
    expect(() =>
      comoSessaoDe(AGENT_A, `update public.contacts set papel_interno = 'secretaria' where id = '${PESSOA}';`),
    ).toThrow(/gerente ou admin/);
    expect(papelDe(PESSOA)).toBe("(nenhum)");
  });

  it("gerente e admin da organização definem", () => {
    comoSessaoDe(MANAGER_A, `update public.contacts set papel_interno = 'secretaria' where id = '${PESSOA}';`);
    expect(papelDe(PESSOA)).toBe("secretaria");
    comoSessaoDe(ADMIN_A, `update public.contacts set papel_interno = 'marketing' where id = '${PESSOA}';`);
    expect(papelDe(PESSOA)).toBe("marketing");
  });

  it("gerente de OUTRA organização não define papel num contato daqui", () => {
    expect(() =>
      comoSessaoDe(MANAGER_B, `update public.contacts set papel_interno = 'secretaria' where id = '${PESSOA}';`),
    ).toThrow(/gerente ou admin/);
    expect(papelDe(PESSOA)).toBe("(nenhum)");
  });

  it("o atendente também não TIRA o papel que um gerente definiu", () => {
    comoSessaoDe(MANAGER_A, `update public.contacts set papel_interno = 'secretaria' where id = '${PESSOA}';`);
    expect(() =>
      comoSessaoDe(AGENT_A, `update public.contacts set papel_interno = null where id = '${PESSOA}';`),
    ).toThrow(/gerente ou admin/);
    expect(papelDe(PESSOA)).toBe("secretaria");
  });

  it("mexer em OUTRA coluna do contato não aciona a guarda (o atendente segue editando o resto)", () => {
    comoSessaoDe(MANAGER_A, `update public.contacts set papel_interno = 'secretaria' where id = '${PESSOA}';`);
    comoSessaoDe(AGENT_A, `update public.contacts set display_name = 'Nome novo' where id = '${PESSOA}';`);
    expect(papelDe(PESSOA)).toBe("secretaria");
  });

  it("o backend (service role, sem sessão de usuário) define — é o caminho da rota, que já checou o papel", () => {
    sql(`update public.contacts set papel_interno = 'marketing' where id = '${PESSOA}';`);
    expect(papelDe(PESSOA)).toBe("marketing");
  });

  it("criar contato JÁ com papel exige gerente: o atendente não contorna pelo INSERT", () => {
    const novo = "dddddddd-2222-4000-8000-00000000000b";
    sql(`delete from public.contacts where id = '${novo}';`);
    const inserir = (user: string) =>
      comoSessaoDe(
        user,
        `insert into public.contacts (id, organization_id, display_name, fora_do_funil_em, papel_interno)
           values ('${novo}', '${ORG_A}', 'Novo', now(), 'marketing');`,
      );
    expect(() => inserir(AGENT_A)).toThrow(/gerente ou admin/);
    expect(() => inserir(MANAGER_A)).not.toThrow();
    sql(`delete from public.contacts where id = '${novo}';`);
  });
});
