import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * QR CODES E RELATÓRIOS: isolamento entre organizações E gate de papel (manager+).
 *
 * As três tabelas exigem `manager` para ler (o relatório é gestor+). Conectar como `postgres` não mediria
 * nada (rolbypassrls) — aqui é `set role authenticated` + `request.jwt.claims`, o caminho da produção.
 * As funções de relatório são `security invoker`: o mesmo gate tem de valer através delas.
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

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const last = out.split("\n").pop();
  if (last === undefined || !/^-?\d+$/.test(last)) throw new Error(`saída inesperada do psql: ${out}`);
  return Number(last);
}

const ORG_A = "dddddddd-0000-4000-8000-00000000000a";
const ORG_B = "dddddddd-0000-4000-8000-00000000000b";
const MANAGER_A = "dddddddd-1111-4000-8000-00000000000a";
const AGENT_A = "dddddddd-1111-4000-8000-00000000000c";
const MANAGER_B = "dddddddd-1111-4000-8000-00000000000b";
const QR_A = "dddddddd-2222-4000-8000-00000000000a";
const QR_B = "dddddddd-2222-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'qr-mgr-a@invariant.test'),
      ('${AGENT_A}',   'qr-agent-a@invariant.test'),
      ('${MANAGER_B}', 'qr-mgr-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'qr-inv-a', 'QR Invariant A', 'QR A'),
      ('${ORG_B}', 'qr-inv-b', 'QR Invariant B', 'QR B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.qr_codes (id, organization_id, codigo, nome, mensagem) values
      ('${QR_A}', '${ORG_A}', 'AAAA22', 'Cartaz A', 'Olá A'),
      ('${QR_B}', '${ORG_B}', 'BBBB22', 'Cartaz B', 'Olá B')
      on conflict (id) do nothing;
    -- ids fixos + on conflict: rodar de novo na mesma base não pode virar 2 leituras.
    insert into public.qr_code_leituras (id, organization_id, qr_code_id, dispositivo) values
      ('dddddddd-3333-4000-8000-00000000000a', '${ORG_A}', '${QR_A}', 'celular'),
      ('dddddddd-3333-4000-8000-00000000000b', '${ORG_B}', '${QR_B}', 'celular')
      on conflict (id) do nothing;
  `);
});

describe("qr_codes e leituras: isolamento e papel", () => {
  it("manager A vê os da org A e NÃO vê os da org B", () => {
    expect(countAs(MANAGER_A, `select count(*) from public.qr_codes where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
    expect(countAs(MANAGER_A, `select count(*) from public.qr_codes where organization_id = '${ORG_B}';`)).toBe(0);
    expect(countAs(MANAGER_A, `select count(*) from public.qr_code_leituras where organization_id = '${ORG_B}';`)).toBe(0);
  });

  it("agent da PRÓPRIA org não lê (o relatório é gestor+)", () => {
    expect(countAs(AGENT_A, `select count(*) from public.qr_codes;`)).toBe(0);
    expect(countAs(AGENT_A, `select count(*) from public.qr_code_leituras;`)).toBe(0);
  });

  it("manager A não cria QR na org B", () => {
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
        insert into public.qr_codes (organization_id, codigo, nome, mensagem) values ('${ORG_B}', 'CCCC22', 'x', 'y');
      `),
    ).toThrow();
  });

  it("agent não cria QR nem na própria org", () => {
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${AGENT_A}"}', false);
        insert into public.qr_codes (organization_id, codigo, nome, mensagem) values ('${ORG_A}', 'DDDD22', 'x', 'y');
      `),
    ).toThrow();
  });

  it("código fora do alfabeto é recusado pelo banco", () => {
    expect(() =>
      sql(`insert into public.qr_codes (organization_id, codigo, nome, mensagem) values ('${ORG_A}', 'ABC10O', 'x', 'y');`),
    ).toThrow();
  });

  it("código é único na INSTALAÇÃO (a rota pública não sabe a org)", () => {
    expect(() =>
      sql(`insert into public.qr_codes (organization_id, codigo, nome, mensagem) values ('${ORG_B}', 'AAAA22', 'x', 'y');`),
    ).toThrow();
  });
});

describe("funções de relatório", () => {
  it("a função do QR, chamada por manager B pedindo a org A, não devolve linha nenhuma", () => {
    expect(
      countAs(
        MANAGER_B,
        `select count(*) from public.fn_relatorio_de_qr_codes('${ORG_A}', now() - interval '1 day', now() + interval '1 day');`,
      ),
    ).toBe(0);
  });

  it("manager A vê a leitura do próprio QR pela função", () => {
    expect(
      countAs(
        MANAGER_A,
        `select coalesce(sum(leituras),0) from public.fn_relatorio_de_qr_codes('${ORG_A}', now() - interval '1 day', now() + interval '1 day');`,
      ),
    ).toBe(1);
  });

  it("anon não executa nenhuma das três funções", () => {
    for (const fn of [
      "fn_relatorio_de_origens(uuid,timestamptz,timestamptz)",
      "fn_relatorio_de_origens_por_dia(uuid,timestamptz,timestamptz,text)",
      "fn_relatorio_de_qr_codes(uuid,timestamptz,timestamptz)",
    ]) {
      expect(sql(`select has_function_privilege('anon', 'public.${fn}', 'execute');`)).toBe("f");
    }
  });
});
