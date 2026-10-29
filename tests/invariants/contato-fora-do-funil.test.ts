import { execFileSync } from "node:child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * CONTATO "FORA DO FUNIL": o marcador, o espelho nos negócios, os tipos e os números que deixam de contá-lo.
 *
 * O espelho (`crm_leads.fora_do_funil`) é mantido SÓ pelo banco: marcar o contato acende o dos negócios dele,
 * desmarcar apaga, e negócio novo já nasce certo. É o que permite as telas filtrarem com um `.eq(...)` e o negócio
 * voltar inteiro ao desmarcar — e é o que estes casos travam. Os relatórios e o Desempenho são funções do banco,
 * então a prova também é aqui: marcar tem de mudar o número que o gestor lê.
 *
 * `set role authenticated` + `request.jwt.claims` é o caminho da produção; como `postgres` (rolbypassrls) a RLS
 * não mediria nada.
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

const ORG_A = "eeeeeeee-0000-4000-8000-00000000000a";
const ORG_B = "eeeeeeee-0000-4000-8000-00000000000b";
const MANAGER_A = "eeeeeeee-1111-4000-8000-00000000000a";
const AGENT_A = "eeeeeeee-1111-4000-8000-00000000000c";
const MANAGER_B = "eeeeeeee-1111-4000-8000-00000000000b";
const CLIENTE = "eeeeeeee-2222-4000-8000-00000000000a"; // é do funil
const EQUIPE = "eeeeeeee-2222-4000-8000-00000000000b"; // vai ser marcado
const LEAD_CLIENTE = "eeeeeeee-3333-4000-8000-00000000000a";
const LEAD_EQUIPE = "eeeeeeee-3333-4000-8000-00000000000b";
const TIPO_A = "eeeeeeee-4444-4000-8000-00000000000a";
const TIPO_B = "eeeeeeee-4444-4000-8000-00000000000b";

const leadSql = (id: string, org: string, contato: string | null, titulo: string) => `
  insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status, owner_user_id)
  select '${id}', '${org}', s.pipeline_id, s.id, ${contato ? `'${contato}'` : "null"}, '${titulo}', 'open', '${MANAGER_A}'
    from public.crm_stages s
   where s.organization_id = '${org}' and not s.is_won and not s.is_lost
   order by s.position limit 1
  on conflict (id) do nothing;`;

const foraDoFunilDoLead = (id: string) => sql(`select fora_do_funil from public.crm_leads where id = '${id}';`);
const marcar = (contato: string) =>
  sql(`update public.contacts set fora_do_funil_em = now() where id = '${contato}';`);
const desmarcar = (contato: string) =>
  sql(`update public.contacts set fora_do_funil_em = null, fora_do_funil_tipo_id = null where id = '${contato}';`);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'fdf-mgr-a@invariant.test'),
      ('${AGENT_A}',   'fdf-agent-a@invariant.test'),
      ('${MANAGER_B}', 'fdf-mgr-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'fdf-inv-a', 'FDF Invariant A', 'FDF A'),
      ('${ORG_B}', 'fdf-inv-b', 'FDF Invariant B', 'FDF B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CLIENTE}', '${ORG_A}', 'Cliente de Verdade'),
      ('${EQUIPE}',  '${ORG_A}', 'Pessoa da Equipe')
      on conflict (id) do nothing;
    insert into public.tipos_fora_do_funil (id, organization_id, nome) values
      ('${TIPO_A}', '${ORG_A}', 'Equipe'),
      ('${TIPO_B}', '${ORG_B}', 'Equipe')
      on conflict (id) do nothing;
  `);
  sql(leadSql(LEAD_CLIENTE, ORG_A, CLIENTE, "Negócio do cliente"));
  sql(leadSql(LEAD_EQUIPE, ORG_A, EQUIPE, "Negócio da equipe"));
});

beforeEach(() => {
  desmarcar(EQUIPE);
});

describe("tipos_fora_do_funil: quem lê, quem escreve, isolamento", () => {
  it("o atendente lê os tipos da PRÓPRIA organização e nada da vizinha", () => {
    expect(numeroComo(AGENT_A, `select count(*) from public.tipos_fora_do_funil where organization_id = '${ORG_A}';`)).toBe(1);
    expect(numeroComo(AGENT_A, `select count(*) from public.tipos_fora_do_funil where organization_id = '${ORG_B}';`)).toBe(0);
  });

  it("o atendente NÃO cria tipo; o gestor cria na própria organização e não na vizinha", () => {
    const criar = (user: string, org: string, nome: string) =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${user}"}', false);
        insert into public.tipos_fora_do_funil (organization_id, nome) values ('${org}', '${nome}');
      `);
    expect(() => criar(AGENT_A, ORG_A, "Contador")).toThrow();
    expect(() => criar(MANAGER_A, ORG_B, "Contador")).toThrow();
    expect(() => criar(MANAGER_A, ORG_A, "Contador")).not.toThrow();
  });

  it("o nome é único por organização sem diferenciar maiúscula; arquivado libera o nome", () => {
    expect(() =>
      sql(`insert into public.tipos_fora_do_funil (organization_id, nome) values ('${ORG_A}', ' EQUIPE ');`),
    ).toThrow();
    sql(`update public.tipos_fora_do_funil set arquivado_em = now() where id = '${TIPO_A}';`);
    expect(() =>
      sql(`insert into public.tipos_fora_do_funil (organization_id, nome) values ('${ORG_A}', 'Equipe');`),
    ).not.toThrow();
    // devolve o estado para os casos seguintes
    sql(`delete from public.tipos_fora_do_funil where organization_id = '${ORG_A}' and id <> '${TIPO_A}' and nome in ('Equipe');
         update public.tipos_fora_do_funil set arquivado_em = null where id = '${TIPO_A}';`);
  });

  it("tipo sem o marcador é recusado pelo banco", () => {
    expect(() =>
      sql(`update public.contacts set fora_do_funil_tipo_id = '${TIPO_A}' where id = '${EQUIPE}';`),
    ).toThrow();
    expect(() =>
      sql(`update public.contacts set fora_do_funil_em = now(), fora_do_funil_tipo_id = '${TIPO_A}' where id = '${EQUIPE}';`),
    ).not.toThrow();
  });
});

describe("o espelho nos negócios", () => {
  it("marcar o contato acende o espelho dos negócios DELE, e só deles", () => {
    expect(foraDoFunilDoLead(LEAD_EQUIPE)).toBe("f");
    marcar(EQUIPE);
    expect(foraDoFunilDoLead(LEAD_EQUIPE)).toBe("t");
    expect(foraDoFunilDoLead(LEAD_CLIENTE)).toBe("f");
  });

  it("desmarcar devolve o negócio inteiro (nada se perdeu)", () => {
    marcar(EQUIPE);
    desmarcar(EQUIPE);
    expect(foraDoFunilDoLead(LEAD_EQUIPE)).toBe("f");
    expect(sql(`select title, status from public.crm_leads where id = '${LEAD_EQUIPE}';`)).toBe("Negócio da equipe|open");
  });

  it("negócio NOVO de contato marcado já nasce fora do funil; de contato normal, não", () => {
    marcar(EQUIPE);
    sql(leadSql("eeeeeeee-3333-4000-8000-0000000000e1", ORG_A, EQUIPE, "Novo da equipe"));
    sql(leadSql("eeeeeeee-3333-4000-8000-0000000000e2", ORG_A, CLIENTE, "Novo do cliente"));
    sql(leadSql("eeeeeeee-3333-4000-8000-0000000000e3", ORG_A, null, "Sem contato"));
    expect(foraDoFunilDoLead("eeeeeeee-3333-4000-8000-0000000000e1")).toBe("t");
    expect(foraDoFunilDoLead("eeeeeeee-3333-4000-8000-0000000000e2")).toBe("f");
    expect(foraDoFunilDoLead("eeeeeeee-3333-4000-8000-0000000000e3")).toBe("f");
    sql(`delete from public.crm_leads where id in ('eeeeeeee-3333-4000-8000-0000000000e1','eeeeeeee-3333-4000-8000-0000000000e2','eeeeeeee-3333-4000-8000-0000000000e3');`);
  });

  it("negócio que troca de contato refaz o espelho", () => {
    marcar(EQUIPE);
    sql(`update public.crm_leads set contact_id = '${CLIENTE}' where id = '${LEAD_EQUIPE}';`);
    expect(foraDoFunilDoLead(LEAD_EQUIPE)).toBe("f");
    sql(`update public.crm_leads set contact_id = '${EQUIPE}' where id = '${LEAD_EQUIPE}';`);
    expect(foraDoFunilDoLead(LEAD_EQUIPE)).toBe("t");
  });

  it("os dois gatilhos não são executáveis por anon nem por authenticated", () => {
    for (const fn of ["fn_espelha_fora_do_funil_nos_leads()", "fn_lead_herda_fora_do_funil()"]) {
      for (const papel of ["anon", "authenticated"]) {
        expect(sql(`select has_function_privilege('${papel}', 'public.${fn}', 'execute');`), `${papel} ${fn}`).toBe("f");
      }
    }
  });
});

describe("os números que deixam de contar quem está fora do funil", () => {
  const JANELA = `now() - interval '1 day', now() + interval '1 day'`;
  const leadsDoRelatorio = () =>
    numeroComo(MANAGER_A, `select coalesce(sum(leads),0) from public.fn_relatorio_de_origens('${ORG_A}', ${JANELA});`);
  const abertosNoFunil = () =>
    numeroComo(
      MANAGER_A,
      `select coalesce(sum((e->>'count')::int),0) from jsonb_array_elements(
         public.fn_attendant_metrics('${ORG_A}', ${JANELA}, null)->'funnel') e;`,
    );

  it("o relatório de origens: marcar tira o negócio da conta, desmarcar devolve", () => {
    const antes = leadsDoRelatorio();
    expect(antes).toBeGreaterThanOrEqual(2);
    marcar(EQUIPE);
    expect(leadsDoRelatorio()).toBe(antes - 1);
    desmarcar(EQUIPE);
    expect(leadsDoRelatorio()).toBe(antes);
  });

  it("a série por dia também", () => {
    const porDia = () =>
      numeroComo(MANAGER_A, `select coalesce(sum(leads),0) from public.fn_relatorio_de_origens_por_dia('${ORG_A}', ${JANELA});`);
    const antes = porDia();
    marcar(EQUIPE);
    expect(porDia()).toBe(antes - 1);
  });

  it("o Desempenho: o funil de negócios abertos ignora quem está fora", () => {
    const antes = abertosNoFunil();
    expect(antes).toBeGreaterThanOrEqual(2);
    marcar(EQUIPE);
    expect(abertosNoFunil()).toBe(antes - 1);
    desmarcar(EQUIPE);
    expect(abertosNoFunil()).toBe(antes);
  });

  it("o Desempenho: venda ganha de quem está fora também sai", () => {
    sql(`update public.crm_leads set status = 'won', closed_at = now() where id = '${LEAD_EQUIPE}';`);
    const ganhos = () =>
      numeroComo(
        MANAGER_A,
        `select coalesce(sum((a->>'won')::int),0) from jsonb_array_elements(
           public.fn_attendant_metrics('${ORG_A}', ${JANELA}, null)->'attendants') a;`,
      );
    expect(ganhos()).toBe(1);
    marcar(EQUIPE);
    expect(ganhos()).toBe(0);
    desmarcar(EQUIPE);
    sql(`update public.crm_leads set status = 'open', closed_at = null where id = '${LEAD_EQUIPE}';`);
  });
});
